/**
 * Strict ISO 8601 date-string validator.
 *
 * `Date.parse` is intentionally lenient: it accepts locale-style strings like
 * `"01/02/2027"` and silently overflows calendar dates (`"2026-02-30"` becomes
 * March 2). Both failure modes can cause one-shot `runAt` / `expiresAt` tasks
 * to fire at the wrong time or never expire as intended.
 *
 * This module exports a single validator that applies two gates in sequence:
 *
 *   1. **Regex gate** — accepts only the ISO 8601 forms that existing callers
 *      produce and that the tool descriptions document:
 *        • Date-only:             `YYYY-MM-DD`
 *        • With time (Z offset):  `YYYY-MM-DDTHH:MM:SSZ`
 *        • With time (±hh:mm):   `YYYY-MM-DDTHH:MM:SS+05:30`
 *        • Fractional seconds:    `YYYY-MM-DDTHH:MM:SS.sssZ`
 *      The regex is purposely structural: it checks the shape and numeric
 *      ranges of each field (month 01–12, day 01–31, hour 00–23, etc.) but
 *      does not encode full Gregorian calendar logic — that is the round-trip
 *      gate's job.
 *
 *   2. **Round-trip gate** — parses the accepted string with `Date.parse` and
 *      reconstructs an ISO string from the resulting timestamp. If the
 *      reconstructed date's calendar components (year, month, day) differ from
 *      the input, the original string encoded an overflowing date (e.g.
 *      Feb 30) and is rejected.
 *
 * Accepted by design:
 *   - `null` — callers use null to mean "clear this field"; pass-through is
 *     explicit so callers can safely check `isValidIsoDate(value)` before
 *     treating it as a string. null is NOT a valid date — callers must handle
 *     it before calling this function if they want to accept it.
 *   - `undefined` — same as null; out-of-scope for this validator.
 *
 * @module utils/iso-date
 */

// Contract: pattern matches the ISO 8601 subsets produced by Date.toISOString()
// (UTC full form) and common offset forms. Field ranges are numeric only — the
// round-trip gate handles calendar-overflow rejection.
const ISO_DATE_RE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-](0\d|1[0-4]):[0-5]\d))?$/;

/**
 * Return `true` when `value` is a strict ISO 8601 string that encodes a
 * real calendar date (no month/day overflow).
 *
 * Returns `false` for every non-string, non-ISO, or overflowing input —
 * including locale-style strings like `"01/02/2027"` and overflow dates
 * like `"2026-02-30"`.
 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!ISO_DATE_RE.test(value)) return false;

  // Round-trip gate: parse → reconstruct → compare calendar components.
  const ms = Date.parse(value);
  if (isNaN(ms)) return false;

  // Extract the declared YYYY-MM-DD from the input string.
  const inputDate = value.slice(0, 10); // "YYYY-MM-DD"
  const [yearStr, monthStr, dayStr] = inputDate.split('-') as [string, string, string];
  const inputYear  = parseInt(yearStr,  10);
  const inputMonth = parseInt(monthStr, 10);
  const inputDay   = parseInt(dayStr,   10);

  // To check for calendar overflow we must compare against the date as seen
  // in the declared offset, not always UTC:
  //
  // - Date-only strings (YYYY-MM-DD) are parsed as UTC by Date.parse, so
  //   UTC components equal the declared date.
  // - "Z" strings are also UTC, so UTC components work.
  // - Offset strings (±HH:MM) shift the UTC epoch, so UTC components may
  //   reflect the day before/after the declared date. We reconstruct the
  //   declared local components by adding the offset minutes back to UTC.
  //
  // Contract: this arithmetic never produces an incorrect overflow verdict
  // because the offset value itself was range-checked by the regex gate.
  let checkYear: number;
  let checkMonth: number;
  let checkDay: number;

  const offsetMatch = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (offsetMatch) {
    const sign   = offsetMatch[1] === '+' ? 1 : -1;
    // offsetMatch[2] and [3] are always defined when the regex matches — the
    // prior `?? '0'` fallbacks were dead code (the regex requires both groups).
    const offH   = parseInt(offsetMatch[2]!, 10);
    const offM   = parseInt(offsetMatch[3]!, 10);
    const offsetMs = sign * (offH * 60 + offM) * 60_000;
    const localMs  = ms + offsetMs; // shift UTC epoch to declared-offset local time
    const local    = new Date(localMs);
    checkYear  = local.getUTCFullYear();
    checkMonth = local.getUTCMonth() + 1;
    checkDay   = local.getUTCDate();
  } else {
    // Date-only or Z suffix — compare directly against UTC components.
    const d  = new Date(ms);
    checkYear  = d.getUTCFullYear();
    checkMonth = d.getUTCMonth() + 1;
    checkDay   = d.getUTCDate();
  }

  if (checkYear !== inputYear || checkMonth !== inputMonth || checkDay !== inputDay) {
    return false; // overflowing calendar date
  }

  return true;
}
