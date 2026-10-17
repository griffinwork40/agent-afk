/** Warn without reinterpreting legitimate yearly cron schedules as one-shots. */
export function datePinnedCronWarning(task: { cron: string; runAt?: string }): { warning?: string } {
  if (task.runAt !== undefined) return {};
  const fields = task.cron.trim().split(/\s+/);
  if (fields.length !== 5 || !/^\d+$/.test(fields[2] ?? '')
    || !/^(\d+|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(fields[3] ?? '')) return {};
  return {
    warning: 'This cron pins both day-of-month and month and repeats annually (it has no year field); it will NOT auto-disable. For a one-shot, set runAt to an ISO 8601 datetime instead.',
  };
}
