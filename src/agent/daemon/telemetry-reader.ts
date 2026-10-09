/**
 * Bounded schedule-telemetry reader.
 *
 * The four previous schedule-history sites each re-implemented the same
 * pattern: read the whole file (or a 1 MB tail), split on `\n`, scan
 * backwards for records matching `taskId`, and slice to a limit. The "tail"
 * bound did not bound I/O — a `readFileSync` of the full multi-MB file was
 * required before the tail was sliced.
 *
 * This module provides `readTelemetryHistory`, which:
 *   1. Opens the file and seeks to `max(0, size - tailBytes)` to bound the
 *      I/O to `tailBytes` (default 1 MiB).
 *   2. Scans backwards through the tail lines for records matching `taskId`.
 *   3. Returns at most `limit` records in chronological order (oldest first).
 *
 * All four history sites (gates.ts `readLastTickTime` stays sync and is
 * deliberately excluded — it already reads the whole file by design for a
 * single-record lookup, but is covered by #3266's first acceptance criterion
 * which only lists history queries) now call this shared implementation.
 *
 * @module agent/daemon/telemetry-reader
 */

import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { IncrementalLineReader } from '../../utils/jsonl.js';

/** Default tail window read from disk (1 MiB). */
export const DEFAULT_TAIL_BYTES = 1_048_576;

/** Default maximum number of records returned. */
export const DEFAULT_HISTORY_LIMIT = 10;

/** Options for {@link readTelemetryHistory}. */
export interface ReadTelemetryHistoryOptions {
  /** Task id to filter on. Required. */
  taskId: string;
  /** Maximum number of records to return. Default: 10. Max enforced at caller. */
  limit?: number;
  /** Maximum bytes to read from the tail of the file. Default: 1 MiB. */
  tailBytes?: number;
}

/**
 * Read recent telemetry history for a single task from the telemetry JSONL
 * file, bounding I/O to `tailBytes` from the end of the file.
 *
 * Returns records in chronological order (oldest first), limited to `limit`
 * entries. Returns an empty array when the file does not exist or the task
 * has no recorded entries in the tail window.
 *
 * The function is async to use the non-blocking `fsp.open` / `fd.read`
 * path — it is called from both the HTTP routes layer and the tool handler,
 * where blocking the event loop on multi-MB reads is observable.
 *
 * @param telemetryPath  Absolute path to the JSONL telemetry file.
 * @param options        Filter and bound parameters.
 */
export async function readTelemetryHistory(
  telemetryPath: string,
  options: ReadTelemetryHistoryOptions,
): Promise<unknown[]> {
  const { taskId, limit = DEFAULT_HISTORY_LIMIT, tailBytes = DEFAULT_TAIL_BYTES } = options;

  if (!existsSync(telemetryPath)) return [];

  let fd: fsp.FileHandle | null = null;
  try {
    fd = await fsp.open(telemetryPath, 'r');
    const stat = await fd.stat();
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    const readStart = fileSize > tailBytes ? fileSize - tailBytes : 0;
    const toRead = fileSize - readStart;
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fd.read(buf, 0, toRead, readStart);
    const content = buf.toString('utf8', 0, bytesRead);

    // Feed the content through IncrementalLineReader to handle any partial
    // leading line (when the tail cut mid-line, the first "line" may be
    // truncated — we discard it by always calling flush() which drains the
    // remainder; the split() call from feed() handles the bulk).
    const reader = new IncrementalLineReader();
    const lines = reader.feed(content);
    // Drain any trailing fragment (no trailing \n in tail).
    const trailing = reader.flush();
    if (trailing.length > 0) lines.push(...trailing);

    // Scan backwards for records matching taskId, stop at limit.
    const matching: unknown[] = [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (matching.length >= limit) break;
      const line = lines[i];
      if (!line) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        record !== null &&
        typeof record === 'object' &&
        (record as Record<string, unknown>)['taskId'] === taskId
      ) {
        matching.push(record);
      }
    }

    // Return chronological order (oldest first).
    return matching.reverse();
  } catch {
    return [];
  } finally {
    await fd?.close().catch(() => undefined);
  }
}
