/**
 * Shared display formatters and types for the `worktree` CLI command and the
 * `/worktree` slash command.
 *
 * Keep this module free of CLI / slash-command imports — it is a pure utility
 * layer that both surfaces can import without introducing a circular dependency.
 *
 * @module agent/worktree/display
 */

import { palette } from '../../cli/palette.js';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export const VALID_SCOPES = ['interactive', 'diagnose', 'all'] as const;
export type Scope = (typeof VALID_SCOPES)[number];

/**
 * Validate and narrow a raw string into the `Scope` union.
 * Throws with a human-readable message on an unrecognised value.
 */
export function parseScope(raw: string): Scope {
  if ((VALID_SCOPES as readonly string[]).includes(raw)) return raw as Scope;
  throw new Error(
    `Invalid --scope value: '${raw}'. Allowed: ${VALID_SCOPES.join(' | ')}.`,
  );
}

// ---------------------------------------------------------------------------
// Verdict classification
// ---------------------------------------------------------------------------

/**
 * Verdicts the sweep actually removes. `stale-clean` is deliberately absent:
 * the engine preserves and warns on it (commits ahead of base) rather than
 * removing.
 */
export const PRUNABLE_VERDICTS: ReadonlySet<string> = new Set([
  'empty',
  'orphaned-dir',
  'orphaned-registration',
  'dead-owner',
]);

/** Verdicts that produce a warning rather than removal. */
export const WARNING_VERDICTS: ReadonlySet<string> = new Set([
  'stale-clean',
  'stale-dirty',
]);

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format a millisecond age value into a compact human-readable string:
 * `"-"` when age is zero/negative, `"Nh"` for sub-day ages, `"Nd"` otherwise.
 */
export function formatAge(ageMs: number): string {
  if (ageMs <= 0) return '-';
  const days = ageMs / 86_400_000;
  if (days < 1) {
    const hours = Math.max(1, Math.round(ageMs / 3_600_000));
    return `${hours}h`;
  }
  return `${Math.round(days)}d`;
}

/**
 * Colour a verdict label using the palette:
 * - prunable → error (red)
 * - warn-only (stale-*)  → warning (yellow)
 * - everything else      → dim
 */
export function verdictColor(verdict: string, text: string): string {
  if (PRUNABLE_VERDICTS.has(verdict)) return palette.error(text);
  if (WARNING_VERDICTS.has(verdict)) return palette.warning(text);
  return palette.dim(text);
}

/**
 * Render the "PRUNE?" column for a single verdict.
 * - prunable → coloured `"yes"`
 * - stale-* → coloured `"warn"`
 * - otherwise → coloured `"no"`
 */
export function verdictWouldPrune(verdict: string): string {
  if (PRUNABLE_VERDICTS.has(verdict)) return palette.error('yes');
  if (WARNING_VERDICTS.has(verdict)) return palette.warning('warn');
  return palette.success('no');
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

/**
 * Aggregate candidates into a per-verdict count map and return a formatted
 * tally string (e.g. `"[active=2 empty=1 stale-dirty=3]"`) or `""` when
 * the candidate list is empty.
 */
export function buildVerdictTallyString(
  candidates: ReadonlyArray<{ verdict: string }>,
): string {
  const tally: Record<string, number> = {};
  for (const c of candidates) {
    tally[c.verdict] = (tally[c.verdict] ?? 0) + 1;
  }
  const parts = Object.entries(tally)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([v, n]) => `${v}=${n}`);
  return parts.length > 0 ? `  [${parts.join(' ')}]` : '';
}
