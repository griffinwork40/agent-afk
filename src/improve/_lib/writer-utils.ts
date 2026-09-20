/**
 * Shared utilities for the improve pipeline writers.
 *
 * ## appendJsonlIndex
 *
 * Every writer in the improve pipeline appends a single line to an
 * `.index.jsonl` event log immediately after the primary artifact(s) are
 * written.  All four writers share the same structural pattern:
 *
 *   1. Validate the event against its Zod schema (catch programming errors
 *      early rather than persisting malformed lines).
 *   2. Ensure the directory exists (the call is idempotent — mkdirSync with
 *      `{ recursive: true }` is a no-op when the dir is already present).
 *   3. Append the validated JSON + newline, best-effort.  A failed index write
 *      does NOT roll back any snapshot already written; the snapshot files
 *      are the source of truth and the index is derived/auditable data.
 *
 * Callers supply a ZodType for their event schema so the generic enforces the
 * shape without duplicating parse calls.
 *
 * ## formatYyyymmdd
 *
 * Shared by the three ID-generation helpers (eval-case, eval-run, proposal).
 * Always uses UTC so IDs are stable across time-zone changes.
 *
 * @module improve/_lib/writer-utils
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { ZodType } from 'zod';

/**
 * Validate `event` against `schema`, ensure `dir` exists, and append the
 * serialised JSON + newline to `indexPath`.
 *
 * The append is best-effort: any write error is swallowed because the index is
 * derived from the snapshot files, which are already durable at call time.
 * Matches the original convention established in `scan/card-writer.ts` and
 * propagated to every subsequent writer.
 */
export function appendJsonlIndex<T>(
  schema: ZodType<T>,
  dir: string,
  indexPath: string,
  event: T,
): void {
  const validated = schema.parse(event);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(indexPath, JSON.stringify(validated) + '\n', { flag: 'a' });
  } catch {
    // Best-effort: index is derived, snapshots are the source of truth.
  }
}

/**
 * Format a `Date` as `yyyymmdd` in UTC.
 *
 * Shared by the three ID-generation helpers that embed a date segment in
 * artifact IDs (eval-case, eval-run, proposal).  UTC is mandatory — IDs must
 * be identical regardless of the host's local time zone.
 */
export function formatYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
