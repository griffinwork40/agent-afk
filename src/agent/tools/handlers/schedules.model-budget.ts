/**
 * Validation helpers for the per-task `model` and `maxBudgetUsd` fields
 * added in #4832. Extracted from `schedules.ts` to satisfy the 350-code-line
 * ceiling; re-imported from both `createScheduleHandler` and
 * `updateScheduleHandler`.
 *
 * @module agent/tools/handlers/schedules.model-budget
 */

/** Result shape returned by both parse helpers. */
type ParseOk<T> = { ok: true; value: T };
type ParseErr = { ok: false; content: string };
type ParseResult<T> = ParseOk<T> | ParseErr;

/**
 * Parse and validate the optional `model` field for `create_schedule`.
 * Returns `{ ok: true, value: string | undefined }` on success.
 */
export function parseCreateModel(
  raw: unknown,
): ParseResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') {
    return { ok: false, content: 'Invalid input: model must be a string' };
  }
  return { ok: true, value: raw || undefined };
}

/**
 * Parse and validate the optional `maxBudgetUsd` field for `create_schedule`.
 * Returns `{ ok: true, value: number | undefined }` on success.
 */
export function parseCreateMaxBudgetUsd(
  raw: unknown,
): ParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !isFinite(raw) || raw < 0) {
    return {
      ok: false,
      content: 'Invalid input: maxBudgetUsd must be a non-negative finite number',
    };
  }
  return { ok: true, value: raw };
}

/**
 * Parse and validate the optional `model` field for `update_schedule`.
 * `null` means "clear the per-task model" and is returned as `null`.
 */
export function parseUpdateModel(
  raw: unknown,
): ParseResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, content: 'Invalid input: model must be a string' };
  }
  return { ok: true, value: raw || undefined };
}

/**
 * Parse and validate the optional `maxBudgetUsd` field for `update_schedule`.
 * `null` means "clear the per-task ceiling" and is returned as `null`.
 */
export function parseUpdateMaxBudgetUsd(
  raw: unknown,
): ParseResult<number | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !isFinite(raw) || raw < 0) {
    return {
      ok: false,
      content: 'Invalid input: maxBudgetUsd must be a non-negative finite number or null to clear',
    };
  }
  return { ok: true, value: raw };
}
