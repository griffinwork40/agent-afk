import { env } from '../../config/env.js';
import { getTerminalWidth } from '../terminal-size.js';

/**
 * Maximum measure for CODE blocks and structured surfaces (tool-lane, thinking).
 *
 * Bordered elements already cap their inner width at 100 columns
 * (`card.ts`, `error-box.ts`, `usage-limit-box.ts`) — this applies the same
 * ceiling to the unbordered surfaces that previously scaled to the full
 * terminal: code fences, thinking blocks, tool-lane text, subagent text.
 *
 * Invariant (two-tier measure): unbordered surfaces use one of two measures.
 * Code fences and structured content (thinking, tool-lane) use this value
 * via {@link capToMeasure}. Prose blocks (paragraphs, list items, blockquotes)
 * use the tighter {@link DEFAULT_PROSE_MEASURE} via {@link capToProseMeasure}.
 * The right-edge discontinuity between 80 and 100 columns is a deliberate
 * trade for prose readability — research converges on 60-80 characters for
 * comfortable reading. If a new unbordered surface is added, route it through
 * the appropriate cap function for its content type.
 */
export const DEFAULT_TEXT_MEASURE = 100;

/**
 * Default measure for prose-only blocks (paragraphs, list items, blockquotes).
 *
 * Prose reads best at 60-80 characters per line — research converges on this
 * range for comfortable reading speed and saccade length. Code blocks stay at
 * {@link DEFAULT_TEXT_MEASURE} because truncating code at 80 columns causes
 * excessive wrapping that harms scanability more than the wider measure helps.
 *
 * Override with `AFK_PROSE_MEASURE`. When `AFK_TEXT_MEASURE` is explicitly set,
 * it overrides BOTH prose and code measures (backward compat).
 */
export const DEFAULT_PROSE_MEASURE = 80;

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

/**
 * Resolve the active prose measure ceiling.
 *
 * Returns `AFK_PROSE_MEASURE` if set, otherwise {@link DEFAULT_PROSE_MEASURE}.
 * When `AFK_TEXT_MEASURE` is explicitly set, it wins over the prose default
 * (backward compat: a user who set `AFK_TEXT_MEASURE=120` expects ALL text at
 * 120, not prose silently narrowed to 80).
 */
export function resolveProseMeasure(): number | null {
  // Explicit AFK_TEXT_MEASURE overrides everything (backward compat).
  const textRaw = env.AFK_TEXT_MEASURE?.trim();
  if (textRaw !== undefined && textRaw !== '') return resolveTextMeasure();

  const raw = env.AFK_PROSE_MEASURE?.trim();
  if (raw === undefined || raw === '') return DEFAULT_PROSE_MEASURE;
  if (/^(full|off|none|0)$/i.test(raw)) return null;
  if (!/^\d+$/.test(raw)) return DEFAULT_PROSE_MEASURE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_TEXT_MEASURE) return DEFAULT_PROSE_MEASURE;
  return parsed;
}

/**
 * Clamp a content width to the prose measure (tighter than the code measure).
 *
 * Use for paragraph text, list items, and blockquotes. Code fences should
 * continue using {@link capToMeasure}.
 */
export function capToProseMeasure(width: number): number {
  const measure = resolveProseMeasure();
  if (measure === null) return width;
  return Math.min(width, measure);
}

/**
 * Left-margin string for centering content at the active text measure.
 *
 * Returns '' (empty string) in all of these cases:
 *   - AFK_CENTER_CONTENT is unset or falsy (default, opt-in feature)
 *   - Terminal width ≤ content measure (no room to center — the common
 *     80–100 column case; margin would be 0 anyway)
 *
 * When centering is active, returns `Math.floor((tw - measure) / 2)` space
 * characters. Callers should prepend this to every content line so that the
 * display floats horizontally centered in wide terminals.
 *
 * Pass `termWidth` to avoid a second `process.stdout.columns` lookup when
 * the caller has already read the width for another purpose (e.g. clamp).
 * Omit to let the function read it fresh.
 */
export function contentMargin(termWidth?: number): string {
  const raw = env.AFK_CENTER_CONTENT;
  if (!raw) return '';
  const v = raw.trim().toLowerCase();
  if (v !== '1' && v !== 'true') return '';
  const tw = termWidth ?? getTerminalWidth();
  const measure = resolveTextMeasure() ?? tw;
  const marginCols = Math.max(0, Math.floor((tw - measure) / 2));
  return ' '.repeat(marginCols);
}
