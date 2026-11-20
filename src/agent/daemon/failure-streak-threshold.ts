// Shared mutation-boundary validation; undefined preserves, null clears on PATCH.
export function validFailureStreakThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function assertFailureStreakThreshold(value: unknown): void {
  if (value !== undefined && !validFailureStreakThreshold(value)) {
    throw new Error('failureStreakThreshold must be a positive integer');
  }
}
type Result<T> = { ok: true; value: { failureStreakThreshold?: T } } | { ok: false; error: string };
export function parseFailureStreakThreshold(obj: Record<string, unknown>): Result<number>;
export function parseFailureStreakThreshold(obj: Record<string, unknown>, allowClear: true): Result<number | null>;
export function parseFailureStreakThreshold(obj: Record<string, unknown>, allowClear = false):
  { ok: true; value: { failureStreakThreshold?: number | null } } | { ok: false; error: string } {
  const raw = obj['failureStreakThreshold'];
  if (raw === undefined) return { ok: true, value: {} };
  if (raw === null && allowClear) return { ok: true, value: { failureStreakThreshold: null } };
  return validFailureStreakThreshold(raw)
    ? { ok: true, value: { failureStreakThreshold: raw } }
    : { ok: false, error: 'failureStreakThreshold must be a positive integer' };
}
