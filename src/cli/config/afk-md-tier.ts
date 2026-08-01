// Contract: the AFK.md auto-discovery tier of the CLI config loader (#368
// split). This module is the SINGLE home of `afkMdCache`. Sibling modules and
// the `config.ts` facade must never duplicate it — the facade resets it only
// through `resetAfkMdCache()` exported here, because ESM importers cannot
// reassign an imported binding (same pattern as `setState()` in the #366
// plugin-skills split).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getAfkHome } from '../../paths.js';

export interface AfkMdResult {
  content: string;
  /**
   * Absolute path(s) that contributed content, in the order they were
   * concatenated into `content` (user-scope first, project-scope second).
   * Length 1 in the common case — only one tier resolved, or both tiers
   * point at the literal same file (e.g. `AFK_HOME` relocated to `cwd`) — in
   * which case `content` is that single file's trimmed text verbatim, with
   * no added headers, byte-identical to the pre-hybrid single-tier result.
   * Length 2 only when `$AFK_HOME/AFK.md` and `<cwd>/AFK.md` are distinct
   * files and both are non-empty.
   */
  paths: string[];
}

let afkMdCache: { value: AfkMdResult | null } | undefined;

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

const userScopeHeader = (path: string): string => `## Personal configuration (${path})`;
const projectScopeHeader = (path: string): string =>
  `## Project configuration (${path}) — takes precedence on conflict`;

/**
 * Load a system-prompt overlay from AFK.md.
 *
 * Additive hybrid — checks BOTH:
 *   1. `$AFK_HOME/AFK.md` (default `~/.afk/AFK.md`) — user-scope, broadest
 *   2. `<cwd>/AFK.md` — project-scope, most specific
 * and concatenates whichever are present and non-empty, user-scope first —
 * mirroring Claude Code's CLAUDE.md load order (broadest first, most
 * specific last, so the more specific instructions land closest to the
 * actual conversation). This replaces the previous "first non-empty wins"
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
 * Memoized via `afkMdCache` — see the cache block above for the
 * invalidation contract.
 */
export function loadAfkMd(): AfkMdResult | null {
  if (afkMdCache !== undefined) return afkMdCache.value;

  const userPath = join(getAfkHome(), 'AFK.md');
  const projectPath = join(process.cwd(), 'AFK.md');

  const userContent = readAfkMdCandidate(userPath);
  // Skip re-reading the same file twice (e.g. AFK_HOME relocated to cwd) —
  // treat it as a single tier rather than duplicating its content.
  const projectContent = projectPath === userPath ? null : readAfkMdCandidate(projectPath);

  let result: AfkMdResult | null;
  if (userContent !== null && projectContent !== null) {
    result = {
      content:
        `${userScopeHeader(userPath)}\n\n${userContent}\n\n` +
        `${projectScopeHeader(projectPath)}\n\n${projectContent}`,
      paths: [userPath, projectPath],
    };
  } else if (projectContent !== null) {
    result = { content: projectContent, paths: [projectPath] };
  } else if (userContent !== null) {
    result = { content: userContent, paths: [userPath] };
  } else {
    result = null;
  }

  afkMdCache = { value: result };
  return afkMdCache.value;
}
