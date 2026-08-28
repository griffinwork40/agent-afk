import { palette } from '../palette.js';

// ─── StatusBadge ──────────────────────────────────────────────────────────────

/**
 * The set of semantic states a status badge can represent.
 *
 * - `running`  — in-flight / active (spinner / progress context)
 * - `done`     — completed successfully
 * - `error`    — failed (real fault, not a deliberate refusal)
 * - `blocked`  — deliberately refused / benign failure (system said no)
 * - `warn`     — caution / degraded / partial
 */
export type BadgeStatus = 'running' | 'done' | 'error' | 'blocked' | 'warn';

/**
 * Render a coloured glyph for the given status.
 *
 * Returns a short ANSI string — glyph only, no surrounding whitespace —
 * suitable for embedding in any single-line or tabular render context.
 *
 * Invariant: resolved at CALL TIME, never hoisted into module-level consts.
 * `palette` is a live view over the active theme (see palette.ts) — capturing
 * `palette.success('✓')` at import time freezes the glyph to the theme that
 * was active at module load. Resolving per-call keeps glyphs in lock-step
 * with `applyTheme()` (mirrors `buildSyntaxTheme()` in syntax-theme.ts).
 *
 * Glyph choices:
 * - `running`  → `●`  (chrome  — neutral, in-motion feel)
 * - `done`     → `✓`  (success — check mark)
 * - `error`    → `✗`  (error   — cross)
 * - `blocked`  → `⊘`  (warning — deliberate refusal, not a fault)
 * - `warn`     → `⚠`  (warning — caution)
 *
 * @param status - The semantic state to represent.
 * @returns Single-glyph ANSI string.
 */
export function statusBadge(status: BadgeStatus): string {
  switch (status) {
    case 'running':  return palette.chrome('●');
    case 'done':     return palette.success('✓');
    case 'error':    return palette.error('✗');
    case 'blocked':  return palette.warning('⊘');
    case 'warn':     return palette.warning('⚠');
  }
}
