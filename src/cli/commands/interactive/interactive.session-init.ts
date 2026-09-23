/**
 * Session bootstrap helpers for `interactive.ts`.
 *
 * Contains pure option-resolution and startup-notification utilities extracted
 * from the monolithic action closure. Every export here is stateless and has no
 * side-effects — all side-effects live in the main `interactive.ts` action.
 *
 * Concerns owned by this module:
 *   - `ThinkingUiMode` flag/env/config resolution
 *   - `worktreeAutoname` flag/env/config resolution
 *   - `startupHintLine` banner text
 *   - `formatAutonameSkipReason` UX helper
 *   - `setInteractiveUpdateNotices` / `getAndClearUpdateNotices` stash for
 *     update banners that need to survive the interactive screen clear
 */

import { env } from '../../../config/env.js';
import type { CliConfig } from '../../config.js';
import type { CliOptions, ThinkingUiMode } from './shared.js';
import type { UpdateInfo } from '../../update-checker.js';
import type { SkipReason } from './worktree-autoname.js';

// ---------------------------------------------------------------------------
// Update-notice stash
// ---------------------------------------------------------------------------

interface UpdateNotices {
  updateInfo: UpdateInfo | null;
  pendingMessage: string | null;
}

let _pendingUpdateNotices: UpdateNotices | null = null;

/**
 * Called by `index.ts` before `program.parse()` to stash any update notices
 * that need to survive the interactive screen clear.
 */
export function setInteractiveUpdateNotices(
  updateInfo: UpdateInfo | null,
  pendingMessage: string | null,
): void {
  _pendingUpdateNotices = { updateInfo, pendingMessage };
}

/**
 * Consume and return any pending update notices, clearing the stash.
 * Returns `null` when there is nothing to emit.
 */
export function getAndClearUpdateNotices(): UpdateNotices | null {
  const notices = _pendingUpdateNotices;
  _pendingUpdateNotices = null;
  return notices;
}

// ---------------------------------------------------------------------------
// ThinkingUiMode resolution
// ---------------------------------------------------------------------------

export function parseThinkingUiMode(raw: string): ThinkingUiMode {
  if (raw === 'summary' || raw === 'live' || raw === 'digest' || raw === 'off') {
    return raw;
  }
  throw new Error(`Invalid --thinking-ui value: ${raw}. Expected summary|live|digest|off`);
}

/**
 * Resolve the REPL thinking-display mode with precedence:
 *   1. `--thinking-ui <mode>` CLI flag (already validated by parseThinkingUiMode)
 *   2. `AFK_THINKING_UI` env (validated here; invalid values ignored, not fatal)
 *   3. `interactive.thinkingUi` from `afk.config.json`
 *   4. Default: `'live'`
 *
 * Display-only — the mode changes how extended-thinking blocks render in the
 * REPL, never whether thinking runs. Mirrors `isAutonameEnabled`'s
 * flag > env > config > default shape so a user can set a persistent default
 * (env or config) that the per-launch `--thinking-ui` flag still overrides.
 */
export function resolveThinkingUi(options: CliOptions, config: CliConfig): ThinkingUiMode {
  if (options.thinkingUi !== undefined) return options.thinkingUi;
  const envRaw = env.AFK_THINKING_UI;
  if (envRaw !== undefined) {
    const lowered = envRaw.trim().toLowerCase();
    if (lowered === 'summary' || lowered === 'live' || lowered === 'digest' || lowered === 'off') {
      return lowered;
    }
    // Invalid env value → fall through to config/default rather than throw;
    // an env typo shouldn't hard-fail an interactive launch.
  }
  const fromConfig = config.interactive?.thinkingUi;
  if (fromConfig !== undefined) return fromConfig;
  return 'live';
}

// ---------------------------------------------------------------------------
// Worktree-autoname enable resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the worktree-autoname enable flag with precedence:
 *   1. `--no-worktree-autoname` CLI flag → false (commander sets
 *      `options.worktreeAutoname = false`)
 *   2. `AFK_WORKTREE_AUTONAME` env: `'0'` / `'false'` → false, else true
 *      when explicitly set
 *   3. `interactive.worktreeAutoname` from `afk.config.json`
 *   4. Default: true
 *
 * The CLI flag is the hard override — passing `--no-worktree-autoname`
 * shuts naming off regardless of env or config.
 */
export function isAutonameEnabled(options: CliOptions, config: CliConfig): boolean {
  if (options.worktreeAutoname === false) return false;
  const envRaw = env.AFK_WORKTREE_AUTONAME;
  if (envRaw !== undefined) {
    const lowered = envRaw.toLowerCase();
    if (lowered === '0' || lowered === 'false' || lowered === 'off' || lowered === 'no') {
      return false;
    }
    return true;
  }
  if (typeof config.interactive?.worktreeAutoname === 'boolean') {
    return config.interactive.worktreeAutoname;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Startup hint line
// ---------------------------------------------------------------------------

/**
 * The hint line rendered under the welcome banner at session startup.
 *
 * Kept deliberately short and first-session-oriented: it teaches the handful
 * of controls a newcomer needs on day one (help, switching models, how to
 * interrupt a turn, how to leave). `/resume` is intentionally NOT listed here —
 * it does nothing for a brand-new user (no prior sessions exist to resume), and
 * for a user who IS resuming it is redundant with the "Resuming … · N prior
 * turns" metaLine the banner already shows. `/resume` stays fully discoverable
 * via `/help` and the `--resume` / `--continue` launch flags, so trimming it
 * from the busiest line of the startup screen costs no real capability.
 *
 * Pure + exported so the content is unit-testable without booting a session.
 */
export function startupHintLine(): string {
  return '/help · /model · @ for files · Shift+Tab mode · Esc to interrupt · /exit to quit';
}

// ---------------------------------------------------------------------------
// Autoname skip-reason formatter
// ---------------------------------------------------------------------------

/**
 * Render the human-readable text for a born-named timestamp-fallback reason.
 *
 * The tags split into two UX classes:
 *
 *  - `empty-message` / `slash-command` — the first turn carried no naming
 *    signal (whitespace, native-handled slash that fell through, or a
 *    plugin-forwarded slash). Return `undefined` to suppress the dim note
 *    in those benign cases.
 *  - `slug-generator-error` / `invalid-slug-output` / `create-failed` /
 *    `unknown` — the haiku call, its output, or the named `git worktree add`
 *    misbehaved. Surface the reason so the operator knows the feature ran and
 *    fell back to the timestamp name (vs. the feature being off).
 *
 * Exported for unit tests.
 */
export function formatAutonameSkipReason(
  reason: SkipReason | 'create-failed' | 'unknown',
  detail: string | undefined,
): string | undefined {
  switch (reason) {
    case 'empty-message':
    case 'slash-command':
      return undefined;
    case 'slug-generator-error':
      return detail ? `slug generation failed: ${detail}` : 'slug generation failed';
    case 'invalid-slug-output':
      return detail
        ? `model returned invalid slug: ${JSON.stringify(detail)}`
        : 'model returned invalid slug';
    case 'create-failed':
      return detail ? `named worktree create failed: ${detail}` : 'named worktree create failed';
    case 'unknown':
    default:
      return 'unknown reason';
  }
}
