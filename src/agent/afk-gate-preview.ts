/**
 * Input-preview helper for the AFK high-risk approval prompt.
 *
 * Exported as a pure function so it is independently unit-testable. The only
 * caller is {@link module:agent/afk-mode-gate}.
 *
 * Design:
 *   - Inputs that fit within `budget` (default 2000) are shown verbatim.
 *   - Longer inputs are middle-truncated so BOTH the head and the tail survive.
 *     The omitted region is labelled with its character count so the operator
 *     can judge whether to investigate before approving.
 *   - Non-string inputs are JSON-stringified first (same as the old `clipInput`).
 *   - Redaction (secrets) is the CALLER's responsibility — apply
 *     {@link redactInlineSecrets} before passing the input here.
 *
 * @module agent/afk-gate-preview
 */

/** Characters shown at each end when the input is middle-truncated. */
export const PREVIEW_HALF = 700;

/**
 * Full budget: inputs up to this length are shown verbatim. Chosen to fit
 * comfortably inside the REPL gate message cap (2400 chars) after the fixed
 * preamble (~120 chars) and the `\n\nInput: ` prefix (~9 chars).
 */
export const PREVIEW_BUDGET = 2000;

/**
 * Produce a bounded, human-readable preview of a tool input.
 *
 * @param s       Already-redacted string to preview.
 * @param budget  Max characters before switching to middle-truncation.
 *                Defaults to {@link PREVIEW_BUDGET}.
 * @returns Preview string, or `''` when the input is empty.
 */
export function previewInput(s: string, budget = PREVIEW_BUDGET): string {
  if (!s) return '';
  if (s.length <= budget) return s;
  const head = s.slice(0, PREVIEW_HALF);
  const tail = s.slice(s.length - PREVIEW_HALF);
  const omitted = s.length - PREVIEW_HALF * 2;
  return `${head}\n[… ${omitted} chars omitted …]\n${tail}`;
}

/**
 * Serialize a tool input to a string, then run {@link previewInput}.
 *
 * Non-string values are JSON-stringified; if that throws, `String()` is used
 * as a last resort.
 */
export function buildInputPreview(input: unknown, budget = PREVIEW_BUDGET): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (!s) return '';
  return previewInput(s, budget);
}
