import { env } from '../../config/env.js';

/**
 * Maximum comfortable reading measure for UNBORDERED streamed text.
 *
 * Bordered elements already cap their inner width at 100 columns
 * (`card.ts`, `error-box.ts`, `usage-limit-box.ts`) — this applies the same
 * ceiling to the unbordered surfaces that previously scaled to the full
 * terminal: assistant prose, thinking blocks, tool-lane text, subagent text.
 *
 * Invariant: every unbordered text surface must share ONE measure. Capping a
 * subset produces a visible right-edge discontinuity on wide terminals —
 * bordered elements can differ in width because the border explains the
 * change, but adjacent unbordered blocks that stop at different columns read
 * as broken wrapping rather than as an intentional measure. If a new
 * unbordered text surface is added, route its wrap width through
 * {@link capToMeasure} too.
 */
export const DEFAULT_TEXT_MEASURE = 100;

/**
 * Floor for a user-supplied measure. Below this, wrapping degrades into
 * near-vertical text; values under the floor fall back to the default rather
 * than rendering something unusable.
 */
export const MIN_TEXT_MEASURE = 20;

/**
 * Resolve the active measure ceiling.
 *
 * Contract: returns a positive column count to cap at, or `null` meaning
 * "uncapped — use the full terminal width" (the pre-measure behaviour).
 * Reads `AFK_TEXT_MEASURE` fresh on every call (no cache) so tests and
 * mid-session env changes take effect immediately; the cost is a short regex
 * against an already-resolved string, negligible beside the wrap work it
 * guards.
 *
 * Accepted values: a positive integer (>= {@link MIN_TEXT_MEASURE}), or one of
 * `full` / `off` / `none` / `0` to disable capping. Unparseable or
 * below-floor values fall back to {@link DEFAULT_TEXT_MEASURE} rather than
 * throwing — a malformed env var must never break rendering.
 */
export function resolveTextMeasure(): number | null {
  const raw = env.AFK_TEXT_MEASURE?.trim();
  if (raw === undefined || raw === '') return DEFAULT_TEXT_MEASURE;
  if (/^(full|off|none|0)$/i.test(raw)) return null;
  if (!/^\d+$/.test(raw)) return DEFAULT_TEXT_MEASURE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_TEXT_MEASURE) return DEFAULT_TEXT_MEASURE;
  return parsed;
}

/**
 * Clamp an already-chrome-adjusted content width to the active measure.
 *
 * Contract: callers pass the width they would otherwise have wrapped at —
 * i.e. terminal width minus indent, prefix, and safety margins — and receive
 * it back unchanged when it already fits inside the measure. This is a pure
 * `min`, never a widen: on terminals at or below the measure (the common
 * 80–100 column case) it is a no-op, so narrow terminals are unaffected.
 */
export function capToMeasure(width: number): number {
  const measure = resolveTextMeasure();
  if (measure === null) return width;
  return Math.min(width, measure);
}
