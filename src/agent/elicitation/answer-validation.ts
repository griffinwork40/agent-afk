/**
 * Shared answer validation for agent `ask_question` elicitations.
 *
 * Extracts value semantics (number bounds, text length, choice membership)
 * that were previously duplicated across the CLI fallback path
 * (`src/cli/elicitation/field-validation.ts`) and the Telegram handler.
 * Both surfaces now delegate text-length checks to `validateTextAnswer`;
 * the CLI lower-level primitives (`validateNumberField`, `validateTextField`)
 * remain for the overlay / readLine loops that carry surface-specific
 * `emptyError` wording.
 *
 * Design constraints:
 *   - No transport / UI deps: this module is pure logic.
 *   - Callers are responsible for trimming `raw` before calling — the
 *     existing CLI paths both trim externally, and matching that convention
 *     avoids introducing a silent asymmetry.
 *   - The empty-input case is deliberately NOT handled here: empty → skip or
 *     empty → re-prompt depends on `allowSkip` and per-surface wording, which
 *     callers manage themselves.  Functions here assume `raw !== ''`.
 *
 * @module agent/elicitation/answer-validation
 */

import type { ElicitationRequest } from '../types/sdk-types.js';

// ---------------------------------------------------------------------------
// Shared result type
// ---------------------------------------------------------------------------

export type AnswerValidationResult =
  | { ok: true; value: string | number }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// validateTextAnswer
// ---------------------------------------------------------------------------

/**
 * Validate a non-empty, pre-trimmed text answer against the request's
 * `minLength` / `maxLength` constraints.
 *
 * Precondition: `raw !== ''` (callers gate on empty before calling).
 */
export function validateTextAnswer(
  raw: string,
  request: Pick<ElicitationRequest, 'minLength' | 'maxLength'>,
): AnswerValidationResult {
  const codePoints = Array.from(raw).length;
  if (request.minLength !== undefined && codePoints < request.minLength) {
    return { ok: false, message: `Response must be at least ${request.minLength} characters.` };
  }
  if (request.maxLength !== undefined && codePoints > request.maxLength) {
    return { ok: false, message: `Response must be at most ${request.maxLength} characters.` };
  }
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// validateNumberAnswer
// ---------------------------------------------------------------------------

/**
 * Validate a number answer against the request's `min` / `max` constraints.
 *
 * Guards against empty strings explicitly: `Number('') === 0`, which is
 * `isFinite` and would silently accept blank input. Although callers today
 * gate on empty upstream, this guard is a defensive invariant so future
 * callers cannot accidentally admit a blank string as zero.
 */
export function validateNumberAnswer(
  raw: string,
  request: Pick<ElicitationRequest, 'min' | 'max'>,
): AnswerValidationResult {
  if (raw === '') {
    return { ok: false, message: 'Please enter a valid number.' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, message: 'Please enter a valid number.' };
  }
  if (request.min !== undefined && n < request.min) {
    return { ok: false, message: `Value must be \u2265 ${request.min}.` };
  }
  if (request.max !== undefined && n > request.max) {
    return { ok: false, message: `Value must be \u2264 ${request.max}.` };
  }
  return { ok: true, value: n };
}
