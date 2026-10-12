/** Validate and normalize POST /tasks time fields before registering a task. */
export function parseTaskRequestTime(obj: Record<string, unknown>):
  | { ok: true; cron: string | undefined; runAt: string | undefined; expiresAt: string | undefined }
  | { ok: false; error: string } {
  const rawCron = obj['cron'] ?? obj['cronExpression'];
  const rawRunAt = obj['runAt'];
  const rawExpiresAt = obj['expiresAt'];
  if (rawCron !== undefined && typeof rawCron !== 'string') {
    return { ok: false, error: 'cron (or cronExpression) must be a string' };
  }
  if (rawRunAt === undefined && rawCron === undefined) {
    return { ok: false, error: 'cron (or cronExpression) or runAt is required' };
  }
  if (rawRunAt !== undefined && (typeof rawRunAt !== 'string' || isNaN(Date.parse(rawRunAt)))) {
    return { ok: false, error: 'runAt must be a valid ISO 8601 date string' };
  }
  if (rawExpiresAt !== undefined && rawExpiresAt !== null &&
      (typeof rawExpiresAt !== 'string' || isNaN(Date.parse(rawExpiresAt)))) {
    return { ok: false, error: 'expiresAt must be a valid ISO 8601 date string' };
  }
  return {
    ok: true,
    cron: rawCron as string | undefined,
    runAt: rawRunAt as string | undefined,
    expiresAt: typeof rawExpiresAt === 'string' ? rawExpiresAt : undefined,
  };
}
