/**
 * Per-task cwd field parsing helpers for schedule routes.
 *
 * Shared by POST /api/schedules (create) and PATCH /api/schedules/:id
 * (update) so the validation logic lives in one place.
 *
 * @module web-server/routes.schedules.cwd
 */

import { validateScheduleCwd } from '../agent/daemon/cwd-validator.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Parse the `cwd` field from a request body for CREATE routes.
 * Returns `{ ok: false; message }` on validation failure, or
 * `{ ok: true; resolved }` with the absolute path on success (undefined when
 * the field is absent). `null` is treated as absent (returns `resolved:
 * undefined`) — you cannot clear a cwd that was never set. A non-string,
 * non-null value (e.g. `cwd: 123`) is a 400.
 */
export function parseCwdCreate(
  body: unknown,
): { ok: false; message: string } | { ok: true; resolved: string | undefined } {
  if (!isRecord(body) || !('cwd' in body)) return { ok: true, resolved: undefined };
  const raw = body['cwd'];
  // null is semantically equivalent to absent on a create route — you can't
  // clear a cwd that was never set. Treat it the same as omitting the field.
  if (raw === null) return { ok: true, resolved: undefined };
  if (typeof raw !== 'string') return { ok: false, message: 'cwd must be a string' };
  if (!raw) return { ok: false, message: 'cwd must be a non-empty string' };
  const result = validateScheduleCwd(raw);
  if (!result.ok) return { ok: false, message: result.error };
  return { ok: true, resolved: result.resolved };
}

/**
 * Parse the `cwd` field from a request body for UPDATE (PATCH) routes.
 * `null` or `""` means "clear the pin" — returns `{ ok: true; resolved: null }`.
 * A non-string, non-null value is a 400.
 * Returns `{ ok: true; resolved: undefined }` when the field is absent.
 */
export function parseCwdUpdate(
  body: unknown,
): { ok: false; message: string } | { ok: true; resolved: string | null | undefined } {
  if (!isRecord(body) || !('cwd' in body)) return { ok: true, resolved: undefined };
  const raw = body['cwd'];
  if (raw === null || raw === '') return { ok: true, resolved: null };
  if (typeof raw !== 'string') return { ok: false, message: 'cwd must be a string, null, or "" to clear' };
  const result = validateScheduleCwd(raw);
  if (!result.ok) return { ok: false, message: result.error };
  return { ok: true, resolved: result.resolved };
}
