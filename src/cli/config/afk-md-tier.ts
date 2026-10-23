// Contract: the AFK.md auto-discovery tier of the CLI config loader (#368
// split). This module is the SINGLE home of `afkMdCache`. Sibling modules and
// the `config.ts` facade must never duplicate it — the facade resets it only
// through `resetAfkMdCache()` exported here, because ESM importers cannot
// reassign an imported binding (same pattern as `setState()` in the #366
// plugin-skills split).

import { readFileSync, existsSync, realpathSync } from 'fs';
// Leaf import, not the `agent/memory` barrel: the barrel drags better-sqlite3
// onto the config-load path and is routinely vi.mock'ed without this export.
import { estimateTokens } from '../../agent/memory/estimate-tokens.js';
import { getUserAfkMdPath, getProjectAfkMdPath } from '../../paths.js';

/**
 * Warn above this estimated token count for the composed AFK.md overlay.
 *
 * The threshold is deliberately the same value used by `/afk-md` so operators
 * see a consistent signal whether they notice the startup warning or run the
 * command themselves. `targets.ts` re-exports this constant so the slash
 * command always reflects the authoritative loader value.
 */
export const OVERLAY_TOKEN_WARN_THRESHOLD = 10_000;

export interface AfkMdResult {
  content: string;
  /**
   * Absolute path(s) that contributed content, in the order they were
   * concatenated into `content` (user-scope first, project-scope second).
   * Length 1 in the common case — only one tier resolved, or both tiers
   * resolve to the same file, whether lexically (`AFK_HOME` relocated to
   * `cwd`) or through a symlink (see `isSameFile`) — in
   * which case `content` is that single file's trimmed text verbatim, with
   * no added headers, byte-identical to the pre-hybrid single-tier result.
   * Length 2 only when `$AFK_HOME/AFK.md` and `<cwd>/AFK.md` are distinct
   * files and both are non-empty.
   */
  paths: string[];
  /**
   * Estimated token count of the composed `content` (chars / 3.5, ceiling),
   * using the same estimator as `/afk-md`. Populated whenever `content` is
   * non-empty; 0 when the result is null (caller never sees that case).
   * Consumers can use this to surface the size signal without re-reading files.
   */
  estimatedTokens: number;
}

let afkMdCache: { cwd: string; value: AfkMdResult | null } | undefined;

/**
 * Tracks paths that have already triggered the size warning so the operator
 * sees it exactly once per process per path set, not once per loadAfkMd call.
 * Module scope is deliberate: warn-once-per-process semantics survive the
 * `afkMdCache` reset path used by tests.
 */
const warnedAfkMdSize = new Set<string>();

/**
 * Deferred-emission buffer. `null` = emit immediately to stderr (default);
 * an array = hold warnings until the caller flushes them.
 *
 * Invariant: the REPL clears the viewport AND scrollback
 * (`\x1b[3J\x1b[2J\x1b[H`) after bootstrap, while `index.ts` calls
 * `loadConfig()` before `parseAsync()`. A warning written directly at that
 * point is erased, and the warn-once set then suppresses every retry — so the
 * pre-parse load runs deferred and the REPL flushes after the clear (via
 * `drainBootWarnings`), while every other command flushes in a `preAction`
 * hook before its own output.
 */
let deferredSizeWarnings: string[] | null = null;

/** Test-only hook to reset the size warn-once tracker and deferral buffer. Internal API. */
export function _resetAfkMdSizeWarnCache(): void {
  warnedAfkMdSize.clear();
  deferredSizeWarnings = null;
}

/** Start buffering size warnings instead of writing them to stderr. Idempotent. */
export function deferAfkMdSizeWarnings(): void {
  deferredSizeWarnings ??= [];
}

/**
 * Write every buffered size warning to stderr and END deferral, so any later
 * warning (e.g. a new path set after `/afk-md reload`) prints immediately.
 * A no-op when nothing was deferred.
 */
export function flushDeferredAfkMdSizeWarnings(): void {
  const pending = deferredSizeWarnings ?? [];
  deferredSizeWarnings = null;
  // eslint-disable-next-line no-console -- one-shot operator UX warning
  for (const msg of pending) console.warn(msg);
}

/**
 * Clear this tier's memoized AFK.md read. Called (only) by
 * `_resetConfigCache()` in the `config.ts` facade — the cache binding lives
 * here and cannot be reassigned by importers under ESM live-binding rules.
 */
export function resetAfkMdCache(): void {
  afkMdCache = undefined;
}

/**
 * Read one AFK.md candidate. Returns `null` when the file is missing,
 * unreadable, or empty/whitespace-only — each tier is checked independently
 * so an accidental blank file at one tier still falls through to (or
 * combines with) the other, rather than silently wiping the prompt.
 */
function readAfkMdCandidate(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Contract: true when both paths denote the same file on disk.
 *
 * Ordering here is load-bearing, not stylistic. Lexical equality is tested
 * first as a pure-string fast path, so the overwhelmingly common shapes (no
 * AFK.md anywhere, or exactly one) never touch the filesystem. Only when the
 * paths differ lexically AND both exist do we resolve symlinks: `realpathSync`
 * THROWS on a missing path, so an ungated call would fail `loadAfkMd()` — and
 * therefore `loadConfig()` — for nearly every caller. When either path is
 * absent the dedup question is moot (a file that isn't there cannot be
 * double-counted), so we report `false` and let `readAfkMdCandidate()`'s own
 * existence check short-circuit as before.
 *
 * Returns `false` rather than throwing on any realpath failure (races,
 * permissions, broken links): a false negative degrades to the pre-existing
 * duplicate-content behavior, whereas a throw would wipe the operator's
 * entire system-prompt overlay.
 */
function isSameFile(a: string, b: string): boolean {
  if (a === b) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const userScopeHeader = (path: string): string => `## Personal configuration (${path})`;
const projectScopeHeader = (path: string): string =>
  `## Project configuration (${path}) — takes precedence on conflict`;

/**
 * Emit a one-shot stderr warning when the composed AFK.md overlay exceeds
 * `OVERLAY_TOKEN_WARN_THRESHOLD` estimated tokens (strictly greater, matching
 * `/afk-md`). Keyed on the joined path string so a different file set re-warns
 * (e.g. after `/afk-md reload`).
 *
 * Contract: call ONLY when the AFK.md tier actually supplies the prompt —
 * `loadConfig()` does so in its tier-3 branch. `loadAfkMd()` itself never
 * warns, because it is also used as a side-effect-free probe to report
 * shadowed files that are NOT sent on any request.
 *
 * Uses `console.warn` (stderr) — never stdout — so one-shot `afk chat`
 * pipelines are not polluted; buffered instead while deferral is active.
 * Warning only: content is never truncated.
 */
export function warnIfAfkMdOversize(result: AfkMdResult): void {
  if (result.estimatedTokens <= OVERLAY_TOKEN_WARN_THRESHOLD) return;
  const key = result.paths.join('\0');
  if (warnedAfkMdSize.has(key)) return;
  warnedAfkMdSize.add(key);
  const pathList = result.paths.map((p) => `  ${p}`).join('\n');
  const tokStr =
    result.estimatedTokens < 1000
      ? `~${result.estimatedTokens}`
      : `~${(result.estimatedTokens / 1000).toFixed(1)}k`;
  const msg =
    `[afk] AFK.md overlay is large (${tokStr} est. tokens) and is sent on every API request.\n` +
    `      Path(s):\n${pathList}\n` +
    `      Run \`/afk-md\` to inspect and trim, or move detail to HOT.md / the fact archive.`;
  if (deferredSizeWarnings !== null) {
    deferredSizeWarnings.push(msg);
    return;
  }
  // eslint-disable-next-line no-console -- one-shot operator UX warning
  console.warn(msg);
}

/**
 * Load a system-prompt overlay from AFK.md.
 *
 * Additive hybrid — checks BOTH:
 *   1. `$AFK_HOME/AFK.md` (default `~/.afk/AFK.md`) — user-scope, broadest
 *   2. `<cwd>/AFK.md` — project-scope, most specific
 * and concatenates whichever are present and non-empty, user-scope first
 * (broadest first, most specific last, so the more specific instructions land
 * closest to the actual conversation — the same ordering Claude Code uses for
 * CLAUDE.md, though this implementation does not walk ancestor directories or
 * support imports). This replaces the previous "first non-empty wins"
 * exclusive fallback, where a project AFK.md fully hid a personal one.
 *
 * When only one tier resolves — by far the common case, since most repos
 * either have their own AFK.md or don't — the result is that file's trimmed
 * content verbatim, with NO added headers: byte-identical to the pre-hybrid
 * single-tier behavior, so nothing changes for a repo with only a project
 * AFK.md or a machine with only a personal one. Headers are injected only
 * when there are genuinely two distinct sources to disambiguate, and the
 * project section is explicitly marked as the conflict-precedence winner
 * rather than relying on positional/recency bias alone.
 *
 * Delivery is unchanged: the returned `content` is still folded directly
 * into the system prompt by `composeSystemPrompt()` under the one outer
 * `# Operator configuration` header — never delivered as a separate
 * synthetic user-turn message the way Claude Code delivers CLAUDE.md.
 *
 * Side-effect-free apart from the memo: the result carries `estimatedTokens`
 * but this function never warns (see `warnIfAfkMdOversize`). Content is never
 * truncated.
 *
 * Memoized via `afkMdCache` — see the cache block above for the
 * invalidation contract.
 */
export function loadAfkMd(cwd: string = process.cwd()): AfkMdResult | null {
  if (afkMdCache?.cwd === cwd) return afkMdCache.value;

  const userPath = getUserAfkMdPath();
  const projectPath = getProjectAfkMdPath(cwd);

  const userContent = readAfkMdCandidate(userPath);
  // Skip re-reading the same file twice — treat it as a single tier rather
  // than duplicating its content. Covers both the lexical case (AFK_HOME
  // relocated to cwd) and the resolved case (either path a symlink to the
  // other); see `isSameFile` for why realpath is gated on existence.
  const projectContent = isSameFile(projectPath, userPath)
    ? null
    : readAfkMdCandidate(projectPath);

  let result: AfkMdResult | null;
  if (userContent !== null && projectContent !== null) {
    const content =
      `${userScopeHeader(userPath)}\n\n${userContent}\n\n` +
      `${projectScopeHeader(projectPath)}\n\n${projectContent}`;
    result = {
      content,
      paths: [userPath, projectPath],
      estimatedTokens: estimateTokens(content),
    };
  } else if (projectContent !== null) {
    result = {
      content: projectContent,
      paths: [projectPath],
      estimatedTokens: estimateTokens(projectContent),
    };
  } else if (userContent !== null) {
    result = {
      content: userContent,
      paths: [userPath],
      estimatedTokens: estimateTokens(userContent),
    };
  } else {
    result = null;
  }

  afkMdCache = { cwd, value: result };
  return afkMdCache.value;
}
