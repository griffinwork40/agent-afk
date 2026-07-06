/**
 * Shared value validators for the agent-question `number` / `text` types.
 *
 * History: extracted from `elicitation-repl.ts`'s `renderAgentQuestion()`,
 * where the same bounds-checking logic (finite-number range checks; string
 * min/max-length checks) was copy-pasted once inside the `readTextOverlay`
 * `validate` closure and once inside the non-TTY `readLine` retry loop, with
 * byte-identical error message text in both places. This module is the
 * single source for that logic; both call sites in
 * `elicitation-repl.ts` now call into it.
 *
 * Design note: the "empty input" case is intentionally NOT hard-coded here.
 * The overlay path escapes via Esc ("...or esc to cancel.") while the
 * readLine fallback escapes via a typed `:cancel` token ("...or :cancel to
 * skip.") — those hint strings legitimately differ per caller, so the empty-
 * message is threaded through as `emptyError` rather than unified away.
 * Everything that WAS byte-identical between the two call sites (the finite/
 * NaN check, the min/max bounds checks, and their exact message text) lives
 * here verbatim.
 */

// ---------------------------------------------------------------------------
// Number field
// ---------------------------------------------------------------------------

export interface NumberValidationOptions {
  /** Whether empty input should resolve as an explicit "skip" outcome. */
  allowSkip: boolean;
  min?: number;
  max?: number;
  /** Error text for the empty+!allowSkip case — caller-specific escape hint. */
  emptyError: string;
}

export type NumberValidationOutcome =
  | { ok: true; skip: true }
  | { ok: true; skip: false; value: number }
  | { ok: false; error: string };

/**
 * Validate a trimmed number-field input string against skip/min/max rules.
 * Callers are responsible for trimming `input` before calling (both existing
 * call sites already trim at different points in their own flow — trimming
 * here too would be a no-op for both, but keeping the trim external avoids
 * this module silently assuming a convention neither caller documents).
 */
export function validateNumberField(
  input: string,
  opts: NumberValidationOptions,
): NumberValidationOutcome {
  if (input === '') {
    if (opts.allowSkip) return { ok: true, skip: true };
    return { ok: false, error: opts.emptyError };
  }
  const n = Number(input);
  if (!Number.isFinite(n)) {
    return { ok: false, error: 'Please enter a valid number.' };
  }
  if (opts.min !== undefined && n < opts.min) {
    return { ok: false, error: `Value must be \u2265 ${opts.min}.` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { ok: false, error: `Value must be \u2264 ${opts.max}.` };
  }
  return { ok: true, skip: false, value: n };
}

// ---------------------------------------------------------------------------
// Text field
// ---------------------------------------------------------------------------

export interface TextValidationOptions {
  allowSkip: boolean;
  minLength?: number;
  maxLength?: number;
  emptyError: string;
}

export type TextValidationOutcome =
  | { ok: true; skip: true }
  | { ok: true; skip: false }
  | { ok: false; error: string };

/**
 * Validate a text-field input string against skip/minLength/maxLength rules.
 * Unlike {@link validateNumberField}, callers pass the RAW (possibly
 * untrimmed) value on purpose — the overlay path validates the untrimmed
 * buffer while the readLine fallback validates its already-trimmed input;
 * that pre-existing asymmetry is preserved by leaving trimming to the caller.
 */
export function validateTextField(
  input: string,
  opts: TextValidationOptions,
): TextValidationOutcome {
  if (input === '') {
    if (opts.allowSkip) return { ok: true, skip: true };
    return { ok: false, error: opts.emptyError };
  }
  if (opts.minLength !== undefined && input.length < opts.minLength) {
    return { ok: false, error: `Response must be at least ${opts.minLength} characters.` };
  }
  if (opts.maxLength !== undefined && input.length > opts.maxLength) {
    return { ok: false, error: `Response must be at most ${opts.maxLength} characters.` };
  }
  return { ok: true, skip: false };
}
