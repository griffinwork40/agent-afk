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
 *   - Redaction (secrets) is the CALLER's responsibility — apply
 *     {@link redactInlineSecrets} before passing the input here.
 *
 * @module agent/afk-gate-preview
 */

/**
 * Full budget: inputs up to this length are shown verbatim. Chosen to fit
 * comfortably inside the REPL gate message cap (2400 chars) after the fixed
 * preamble (~120 chars) and the `\n\nInput: ` prefix (~9 chars).
 */
export const PREVIEW_BUDGET = 2000;

/**
 * Overhead of the middle-truncation label `\n[… N chars omitted …]\n`.
 * The fixed frame (`\n[… ` + ` chars omitted …]\n`) is 22 chars; the variable
 * digit count for N is bounded conservatively at 10 (covers up to 9 999 999 999
 * omitted chars — far beyond any realistic input). This constant is subtracted
 * from `budget` when computing the head/tail half so the full output (head +
 * label + tail) never exceeds `budget` characters.
 *
 * @internal
 */
export const LABEL_OVERHEAD = 32; // 22 fixed + 10 digit budget — generous upper bound

/**
 * Produce a bounded, human-readable preview of a tool input.
 *
 * The head/tail half is derived from `budget` and the label overhead so the
 * total output never exceeds `budget` characters regardless of what the caller
 * passes. Previously `PREVIEW_HALF` was a module-level constant (700), which
 * caused `previewInput(s, 10)` to emit up to 1400 chars — longer than the
 * budget. A later fix derived `half` from `budget` alone, but still let the
 * label push the total past `budget`.
 *
 * @param s       Already-redacted string to preview.
 * @param budget  Max characters in the returned string.
 *                Defaults to {@link PREVIEW_BUDGET}.
 * @returns Preview string, or `''` when the input is empty.
 */
export function previewInput(s: string, budget = PREVIEW_BUDGET): string {
  if (!s) return '';
  if (s.length <= budget) return s;
  const half = Math.floor((budget - LABEL_OVERHEAD) / 2);
  if (half <= 0) {
    // Budget too small to accommodate the truncation label — just slice to budget.
    return s.slice(0, budget);
  }
  const head = s.slice(0, half);
  const tail = s.slice(s.length - half);
  const omitted = s.length - half * 2;
  return `${head}\n[… ${omitted} chars omitted …]\n${tail}`;
}

/**
 * Produce a bounded preview of an already-serialized tool-input string.
 *
 * The caller is responsible for serializing `input` to a string before calling
 * this function (and for applying `redactInlineSecrets`). Accepting a `string`
 * instead of `unknown` removes the previous dual-serialization footgun where
 * non-string values were JSON-stringified BOTH here and in `afk-mode-gate.ts`.
 */
export function buildInputPreview(input: string, budget = PREVIEW_BUDGET): string {
  if (!input) return '';
  return previewInput(input, budget);
}
