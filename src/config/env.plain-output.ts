/**
 * Plain-output predicates: `isPlainOutputRequested` and `tmuxPlainOutputNotice`.
 *
 * Extracted from `env.ts` to keep that file within the 350-line ceiling ratchet.
 * Re-exported from `env.ts` for backward compat — callers import from either path.
 *
 * Contract: reads exclusively via `env.*` (never `process.env` directly), keeping
 * this inside the CI-enforced single-read-point boundary (`pnpm audit:env:check`).
 */
import { env } from './env.js';

/**
 * Truthy-check for `AFK_PLAIN_OUTPUT` (the `--plain` CLI flag's env twin),
 * extended with auto-detection of tmux ($TMUX) and GNU screen ($STY).
 *
 * Resolution order (first match wins):
 *   1. AFK_PLAIN_OUTPUT=0  → false  (explicit user opt-out; always wins)
 *   2. AFK_PLAIN_OUTPUT=1  → true   (explicit user opt-in)
 *   3. AFK_TMUX_PLAIN=0    → false  (auto-detection disabled)
 *   4. $TMUX or $STY set   → true   (multiplexer detected; AFK_TMUX_PLAIN defaults to 1)
 *   5. Otherwise           → false
 *
 * Shared by every render-decision site that must treat a `--plain` /
 * `AFK_PLAIN_OUTPUT=1` TTY session as non-TTY for rendering purposes: the
 * REPL renderer seam (`repl-renderer.ts`, between-turn writes), the
 * persistent input surface's compositor arm (`input-surface.ts`), and the
 * per-turn StreamRenderer's `isTTY` computation (`stream-renderer.ts`).
 * Originally module-local to `repl-renderer.ts`; promoted to `env.ts` so all
 * three sites import one predicate instead of drifting copies; extracted here
 * to keep `env.ts` within the file-size ratchet after AFK_TMUX_PLAIN additions.
 */
export function isPlainOutputRequested(): boolean {
  const raw = env.AFK_PLAIN_OUTPUT;
  // AFK_PLAIN_OUTPUT=0 is an explicit user opt-out — it always wins over auto-detection.
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === '0') return false;
    if (v === '1' || v === 'true') return true;
  }
  // Auto-detect: when $TMUX or $STY is set and AFK_TMUX_PLAIN is not disabled.
  const tmuxPlainRaw = env.AFK_TMUX_PLAIN;
  const tmuxPlainDisabled = tmuxPlainRaw !== undefined && tmuxPlainRaw.trim() === '0';
  if (!tmuxPlainDisabled && (env.TMUX ?? env.STY)) return true;
  return false;
}

/**
 * Returns the startup notice string when plain output was auto-activated by
 * tmux/screen detection, or `undefined` when not applicable.
 * - Returns undefined when auto-detection is disabled (AFK_TMUX_PLAIN=0).
 * - Returns undefined when AFK_PLAIN_OUTPUT was set explicitly (user already knows).
 * - Returns a one-line human-readable message when $TMUX or $STY triggered it.
 */
export function tmuxPlainOutputNotice(): string | undefined {
  // Only emit a notice when auto-detection fired — not for explicit opt-in.
  const raw = env.AFK_PLAIN_OUTPUT;
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    // Explicit set (either direction) — no notice needed.
    if (v === '0' || v === '1' || v === 'true') return undefined;
  }
  const tmuxPlainRaw = env.AFK_TMUX_PLAIN;
  if (tmuxPlainRaw !== undefined && tmuxPlainRaw.trim() === '0') return undefined;
  if (env.TMUX) return 'detected tmux — using plain output (set AFK_PLAIN_OUTPUT=0 to override)';
  if (env.STY) return 'detected screen — using plain output (set AFK_PLAIN_OUTPUT=0 to override)';
  return undefined;
}
