/**
 * Shared triage display helpers for the `afk improve` CLI.
 *
 * Pure utility functions (no I/O) shared across `proposals list --triage`
 * and `eval-cases list --triage`.
 *
 * @module cli/commands/improve/triage-helpers
 */

/**
 * Format the age of an artifact (by ISO-8601 `createdAt` string) as a human-
 * readable number of days, suitable for a fixed-width column in a triage table.
 *
 * Examples:
 *   - Created today → "0d"
 *   - Created yesterday → "1d"
 *   - Created 30 days ago → "30d"
 *   - Created over a year ago → "400d"
 *
 * The column is intentionally numeric so that sorting a terminal table by the
 * AGE column reveals the oldest (highest-priority) drafts first.
 */
export function formatAgeDays(createdAt: string, now?: Date): string {
  const created = new Date(createdAt).getTime();
  const nowMs = (now ?? new Date()).getTime();
  const days = Math.floor((nowMs - created) / (1000 * 60 * 60 * 24));
  return `${days}d`;
}
