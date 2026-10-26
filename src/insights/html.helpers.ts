/**
 * Shared HTML rendering helpers for the insights report modules.
 *
 * Extracted from `html.ts` and `html.guardrail-false-positives.ts` to avoid
 * the copy-paste between the two files (advisory finding from #4200 review).
 * All three functions are pure — no I/O, no side effects.
 *
 * @module insights/html.helpers
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Escape HTML special characters to prevent injection / rendering artifacts. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Safe number formatting — returns '0' instead of 'NaN' or 'undefined'. */
export function safeNum(n: number | undefined | null, decimals = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  return n.toFixed(decimals);
}

/**
 * Format a percentage from a fraction (0–1).
 * Returns 'N/A' for non-finite inputs (mirrors the guardrail-false-positives
 * convention; `html.ts` renders these as '0%' — each caller chooses its
 * null-display by using its own wrapper if needed).
 */
export function formatPct(fraction: number | null | undefined): string {
  if (fraction === undefined || fraction === null || !Number.isFinite(fraction)) return 'N/A';
  return `${safeNum(fraction * 100, 1)}%`;
}
