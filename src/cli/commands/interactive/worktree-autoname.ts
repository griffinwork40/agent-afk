/**
 * Auto-name a worktree from the user's first message ("born-named").
 *
 * Default `afk i --worktree` (no value) would name the branch
 * `afk/<timestamp>-<random>` — fine for uniqueness, useless when grepping
 * `.afk-worktrees/` a week later. Instead of creating that timestamp-named
 * worktree at startup and renaming it mid-session (which `git worktree
 * move`s the directory out from under the live `process.cwd()` and breaks
 * in-flight tool calls), worktree creation is DEFERRED: this module fires on
 * the first non-slash user message, distills it into a 2-4 word kebab slug
 * via a cheap haiku call, and creates the worktree once, with its final
 * name, BEFORE the first turn runs. No directory is ever moved.
 *
 * Failure-tolerant by design — the session always ends up in an isolated
 * worktree:
 *   - Model call errors / slug validation failure / empty / slash → create a
 *     timestamp-named worktree instead (`status: 'created-fallback'`)
 *   - Named `git worktree add` collision → fall back to timestamp name
 *   - Collision in `.afk-worktrees/` → append 4-char hex suffix, retry once
 *   - 8s hard timeout via AbortController
 *
 * The slug is purely a UX upgrade. Nothing downstream depends on its
 * content — sweep, telemetry, and release CI all key on path/marker file,
 * not branch name.
 *
 * @module cli/commands/interactive/worktree-autoname
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { oneShotCompletion } from '../../../agent/providers/anthropic-direct/oneshot.js';
import { resolveBranchPrefix, type DeferredWorktree } from './worktree.js';
import type { AgentSession } from '../../../agent/session/agent-session.js';

/**
 * System prompt for the slug-generation call. Locked-down format so we can
 * regex-validate the output deterministically.
 *
 * Examples are intentionally varied to anchor the model on length, style,
 * and the no-prefix rule (the AFK namespace prefix is added downstream when
 * composing the branch name in `runFirstTurnAutoname`, not by the model).
 */
const SLUG_SYSTEM_PROMPT = [
  'Generate a 2-4 word kebab-case slug describing this work request.',
  'Rules:',
  '- ASCII lowercase letters and digits only, separated by single hyphens',
  '- 2 to 4 hyphen-separated words',
  '- Maximum 30 characters total',
  '- No prefix, no quotes, no punctuation other than hyphens',
  '- Output ONLY the slug — no explanation, no preamble',
  'Examples: fix-cleanup-race, add-telegram-allowlist, refactor-prompt-loader, debug-flaky-test',
].join('\n');

/** Strict kebab-case, 2–4 words, ≤30 chars. */
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+){1,3}$/;

const MAX_SLUG_LENGTH = 30;
const MAX_PROMPT_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_HAIKU_MODEL = 'haiku';

/**
 * Enumerated reasons for which `generateSlugFromPrompt` returns null.
 *
 * Surfaced through the optional `onSkip` callback (and propagated to
 * `AutonameOutcome.skipped.reason`) so the UI surface can render a dim
 * diagnostic instead of silently dropping the autoname attempt.
 *
 * Invariant: every `return null` path in `generateSlugFromPrompt` calls
 * `onSkip` with exactly one of these tags before returning.
 */
export type SkipReason =
  | 'empty-message'
  | 'slash-command'
  | 'slug-generator-error'
  | 'invalid-slug-output';

export interface AutonameOptions {
  /** Anthropic API key or OAuth token. Required. */
  token: string;
  /**
   * Haiku model id or alias. Defaults to `'haiku'` (resolves to the latest
   * haiku release via the model-resolution layer in the oneshot helper).
   */
  model?: string;
  /** Hard timeout for the haiku call. Default 8000ms. */
  timeoutMs?: number;
  /** Path to the existing worktree dir (parent dir is `.afk-worktrees/`). */
  worktreePath: string;
  /**
   * Optional external abort signal. Linked to the internal timeout signal —
   * either firing cancels the call. Use for user-initiated cancellation.
   */
  signal?: AbortSignal;
  /** Test injection: stub for the haiku call. Bypasses SDK entirely. */
  slugGenerator?: (message: string, signal: AbortSignal) => Promise<string>;
  /**
   * Diagnostic hook fired exactly once when `generateSlugFromPrompt` is about
   * to return null. The `reason` tag identifies which branch fired; `detail`
   * is an optional human-readable string (e.g. an error message, or the raw
   * model output that failed validation — truncated to 60 chars to keep log
   * lines bounded).
   *
   * Use to surface silent failures in the calling UI; the function itself
   * does not log. Safe to omit — the no-op default preserves the original
   * silent-skip semantics.
   */
  onSkip?: (reason: SkipReason, detail?: string) => void;
}

/**
 * Produce a human-readable kebab slug for the worktree, or null on any
 * failure.
 *
 * @param message The user's first message. Truncated to 1KB before hashing
 *                into the slug-generation prompt.
 * @returns Slug string ready to compose into the worktree branch name, or
 *          `null` if generation/validation/collision-handling failed.
 *          Callers MUST treat null as a signal to use the timestamp name.
 */
export async function generateSlugFromPrompt(
  message: string,
  opts: AutonameOptions,
): Promise<string | null> {
  // Empty / whitespace-only / slash-command messages bypass naming entirely.
  // Slash commands shouldn't get this far for native handlers (the REPL loop
  // branches on `/` before invoking us); plugin-forward slashes (which the
  // REPL falls through on) can reach this guard, hence the explicit tag.
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    opts.onSkip?.('empty-message');
    return null;
  }
  if (trimmed.startsWith('/')) {
    opts.onSkip?.('slash-command');
    return null;
  }

  const truncated = truncateBytes(trimmed, MAX_PROMPT_BYTES);

  // Compose a timeout signal; link with caller's signal if present.
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const signal = opts.signal
    ? anySignal([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  let rawSlug: string;
  try {
    if (opts.slugGenerator) {
      rawSlug = await opts.slugGenerator(truncated, signal);
    } else {
      rawSlug = await oneShotCompletion({
        token: opts.token,
        model: opts.model ?? DEFAULT_HAIKU_MODEL,
        system: SLUG_SYSTEM_PROMPT,
        user: truncated,
        maxTokens: 32,
        signal,
      });
    }
  } catch (err) {
    // Network, auth, timeout, or abort — surface the message and fall through
    // to null. No retry. Detail is bounded to keep log lines tractable.
    const detail = err instanceof Error ? err.message : String(err);
    opts.onSkip?.('slug-generator-error', detail.slice(0, 200));
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const cleaned = sanitizeSlug(rawSlug);
  if (cleaned === null) {
    // Surface a bounded sample of the raw model output for diagnostic value —
    // operators can paste it back and tune SLUG_SYSTEM_PROMPT if the model
    // routinely emits an off-format shape (e.g. quoted, prefixed, sentence).
    opts.onSkip?.('invalid-slug-output', rawSlug.slice(0, 60));
    return null;
  }

  // Collision probe: if `.afk-worktrees/<slug>/` already exists, suffix
  // with 4 hex chars. Any residual branch/dir collision is caught downstream
  // by `git worktree add` itself, which `runFirstTurnAutoname` handles by
  // falling back to the timestamp name.
  const afkRoot = dirname(opts.worktreePath);
  const finalSlug = await disambiguate(cleaned, afkRoot);
  return finalSlug;
}

/**
 * Constrain a model-emitted slug to AFK's contract: lowercase ASCII,
 * 2–4 kebab words, ≤30 chars. Sanitization is a single best-effort pass —
 * if the model returns something fundamentally unparseable (e.g. a sentence
 * with spaces and punctuation), we strip+truncate once and re-validate.
 * No multi-step coercion; better to fall back to the timestamp name than
 * ship a mangled slug.
 *
 * Returns null when no salvageable slug can be extracted.
 */
export function sanitizeSlug(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  if (SLUG_REGEX.test(trimmed) && trimmed.length <= MAX_SLUG_LENGTH) {
    return trimmed;
  }

  // Salvage path. Constraints we must enforce simultaneously:
  //   - ASCII lowercase alnum + single hyphens between words
  //   - 2..4 words (matches SLUG_REGEX's `{1,3}` hyphen-group repeater)
  //   - total length ≤ 30 chars
  //
  // Strategy: normalize → split on hyphens → take ≤4 non-empty words →
  // rejoin, truncating word-by-word so the result both fits and stays
  // within the word cap.
  const collapsed = trimmed
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (collapsed.length === 0) return null;

  const words = collapsed.split('-').filter((w) => w.length > 0).slice(0, 4);
  if (words.length < 2) return null;

  // Pack words left-to-right, dropping any that would push us over 30 chars.
  let assembled = words[0]!;
  for (let i = 1; i < words.length; i++) {
    const next = `${assembled}-${words[i]}`;
    if (next.length > MAX_SLUG_LENGTH) break;
    assembled = next;
  }

  return SLUG_REGEX.test(assembled) ? assembled : null;
}

/**
 * If `.afk-worktrees/<slug>/` already exists, append a 4-char hex suffix.
 * Single retry; collisions on the suffixed form return the suffixed slug
 * anyway (16M-key space — overwhelmingly unlikely to double-collide).
 *
 * We do not probe `git show-ref` for branch-name collisions: `git worktree
 * add -b <branch>` surfaces a branch/dir collision itself, and
 * `runFirstTurnAutoname` routes that into the timestamp fallback. Probing in
 * advance would also race with concurrent `afk i` runs.
 */
async function disambiguate(
  slug: string,
  afkRoot: string,
): Promise<string> {
  if (!(await pathExists(join(afkRoot, slug)))) {
    return slug;
  }
  // Collision found — append 4-hex suffix.
  // Two constraints must be satisfied simultaneously:
  //   1. Total length ≤ MAX_SLUG_LENGTH (30 chars): base ≤ 25 chars.
  //   2. Word count ≤ 3 (SLUG_REGEX allows {1,3} additional hyphen groups,
  //      i.e. 2–4 words total): capping the base to 3 words lets the suffix
  //      become the 4th word without violating the word-count contract.
  const suffix = randomBytes(2).toString('hex');
  const baseWords = slug.split('-').slice(0, 3).join('-');
  const base = baseWords.slice(0, MAX_SLUG_LENGTH - 5); // hard length cap
  return `${base}-${suffix}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting
 * a multi-byte character.
 */
function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // Walk back from maxBytes until we land on a non-continuation byte.
  let end = maxBytes;
  while (end > 0 && (buf[end] !== undefined) && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.slice(0, end).toString('utf8');
}

/**
 * AbortSignal.any polyfill for older Node versions. Node 20+ has it builtin,
 * but be defensive: we run on >=20 per package.json but some 20.x patch
 * releases lacked it.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, signals);

  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Result of the full first-turn worktree-creation pipeline.
 *
 * The session always ends up in an isolated worktree on the first two
 * outcomes — only the branch name differs:
 *
 *  - `created`: the haiku slug succeeded; the worktree was born with the
 *    readable name `<prefix><slug>`.
 *  - `created-fallback`: the slug was skipped or its named creation failed,
 *    so the worktree was born with the default timestamp name instead.
 *    `reason` carries the structured tag (`SkipReason`, `'create-failed'`,
 *    or `'unknown'`) and `detail` the bounded human-readable companion.
 *  - `failed`: even the timestamp-fallback `git worktree add` failed (rare —
 *    e.g. disk full). The session has NO worktree; the caller decides
 *    whether to proceed in the launch cwd or abort.
 */
export type AutonameOutcome =
  | { status: 'created'; path: string; branch: string; slug: string }
  | {
      status: 'created-fallback';
      path: string;
      branch: string;
      reason: SkipReason | 'create-failed' | 'unknown';
      detail?: string;
    }
  | { status: 'failed'; reason: string };

export interface RunAutonameInput {
  /**
   * Deferred worktree from `setupWorktreeDeferred`. Its `create()` is invoked
   * exactly once here, with the slug-derived branch name (or a timestamp
   * fallback). No directory is moved.
   */
  deferred: DeferredWorktree;
  /** The user's first non-slash message text. */
  message: string;
  /** Anthropic credential (api key or OAuth token). */
  token: string;
  /** Optional model id — defaults to `'haiku'`. */
  model?: string;
  /** Optional timeout for the haiku call. Default 8s. */
  timeoutMs?: number;
  /**
   * Optional active session — when provided, `session.setCwd(path)` is
   * called after creation so the first turn's system prompt + tool
   * dispatcher use the new worktree. Pass null/undefined for tests that only
   * exercise the slug + create mechanics without a session.
   */
  session?: AgentSession | null;
  /**
   * Override the branch namespace prefix. Falls through to
   * `resolveBranchPrefix` (env → default 'afk/') when omitted. MUST match the
   * prefix passed to `setupWorktreeDeferred` so the composed branch name is
   * consistent.
   */
  branchPrefix?: string;
  /** Test injection: stub the haiku call. */
  slugGenerator?: (message: string, signal: AbortSignal) => Promise<string>;
  /** External abort signal. */
  signal?: AbortSignal;
}

/**
 * Full pipeline: generate slug → create the worktree with that name →
 * update session cwd → pin `process.cwd()` to the new worktree.
 *
 * Never throws. Every failure path returns a structured outcome; callers
 * decide whether to log/display.
 *
 * On a successful create, two things are updated:
 *   1. `session.config.cwd` + `providerQuery` (via `session.setCwd()`): the
 *      first turn's system prompt + tool-dispatcher closures use the worktree
 *      path. (The first turn has not started yet — this hook is awaited
 *      BEFORE `runTurn` — so there is no in-flight race to lose.)
 *   2. `process.cwd()` is pinned to the worktree (best-effort). The launch
 *      cwd (repo root) was never deleted, so this is a plain forward chdir
 *      into the freshly-created directory — not a recovery from a vanished
 *      cwd. It keeps any `process.cwd()`-fallback spawn anchored in the
 *      worktree.
 *
 * Constraint on (2): `process.chdir` is process-global. This function is
 * wired only from `cli/commands/interactive.ts` — a single-session
 * interactive process. Do NOT call it from concurrent-session hosts
 * (telegram bot, daemon, `afk farm`); a future per-session cwd model would
 * be the correct fix there.
 */
export async function runFirstTurnAutoname(
  input: RunAutonameInput,
): Promise<AutonameOutcome> {
  // Capture the structured skip reason via callback so the surface can
  // render a dim diagnostic. Both vars stay undefined on the happy path.
  let skipReason: SkipReason | undefined;
  let skipDetail: string | undefined;

  // The worktree does not exist yet, so probe collisions against
  // `<repoRoot>/.afk-worktrees`. generateSlugFromPrompt derives the probe
  // root via `dirname(worktreePath)`, so pass a path one level below it.
  const probeWorktreePath = join(input.deferred.repoRoot, '.afk-worktrees', 'unnamed');

  const slug = await generateSlugFromPrompt(input.message, {
    token: input.token,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    worktreePath: probeWorktreePath,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.slugGenerator !== undefined ? { slugGenerator: input.slugGenerator } : {}),
    onSkip: (reason, detail) => {
      skipReason = reason;
      skipDetail = detail;
    },
  });

  // Why we fall back to a timestamp name, if we do.
  let fallbackReason: SkipReason | 'create-failed' | 'unknown' = skipReason ?? 'unknown';
  let fallbackDetail: string | undefined = skipDetail;

  // Happy path: slug succeeded → create the worktree with the readable name.
  if (slug !== null) {
    const prefix = resolveBranchPrefix(input.branchPrefix);
    const branchName = `${prefix}${slug}`;
    try {
      const handle = await input.deferred.create(branchName);
      finalizeWorktreeCwd(input.session, handle.path);
      return { status: 'created', path: handle.path, branch: handle.branch, slug };
    } catch (err) {
      // Named create failed (e.g. the branch/dir already exists from a prior
      // session). Don't give up — fall through to the timestamp fallback so
      // the session still gets an isolated worktree.
      fallbackReason = 'create-failed';
      fallbackDetail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  }

  // Fallback: timestamp-named worktree (createWorktreeAt with `true` uses a
  // random hex suffix, so this is collision-resistant and effectively always
  // succeeds inside a healthy git repo).
  try {
    const handle = await input.deferred.create(true);
    finalizeWorktreeCwd(input.session, handle.path);
    return {
      status: 'created-fallback',
      path: handle.path,
      branch: handle.branch,
      reason: fallbackReason,
      ...(fallbackDetail !== undefined ? { detail: fallbackDetail } : {}),
    };
  } catch (err) {
    // Even the timestamp fallback failed — the repo is in a state where no
    // worktree can be created (disk full, permissions). The "not a git repo"
    // case was already caught fail-fast in setupWorktreeDeferred at startup.
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * After a worktree is created, point both the session and the host process
 * at it: `session.setCwd` rebuilds the provider query's dispatcher (system
 * prompt + read/write roots + resolveBase) for the upcoming first turn, and
 * `pinProcessCwd` chdir's the host so any `process.cwd()`-fallback spawn
 * lands in the worktree.
 */
function finalizeWorktreeCwd(session: AgentSession | null | undefined, path: string): void {
  if (session) {
    session.setCwd(path);
  }
  pinProcessCwd(path);
}

/**
 * Best-effort `process.chdir(newPath)`. Swallows all errors — the worktree
 * was just created at the filesystem layer and the session's primary cwd
 * tracking happened via `session.setCwd()`; failing to pin the process-wide
 * cwd is a degraded but non-fatal state.
 *
 * Exported only so tests can import and verify the chdir attempt without
 * spawning a child process.
 *
 * @internal
 */
export function pinProcessCwd(newPath: string): void {
  try {
    process.chdir(newPath);
  } catch {
    // Best-effort: the directory should exist (we just created it), but the
    // OS may refuse the call in rare cases. Either way, the session's primary
    // cwd state (config.cwd, dispatcher.resolveBase) is already updated; this
    // is just the spawn-fallback safety net.
  }
}
