/**
 * Bounded schedule-telemetry reader.
 *
 * The three previous schedule-history sites each re-implemented the same
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
 * All four schedule-history sites — including `gates.ts` `readLastTickTime`
 * (#3266 scope (a)) — now delegate to this shared implementation.
 *
 * ## Remaining ordinary JSONL parse loops (scope (b)) — audit complete
 *
 * The following sites were evaluated for `parseJsonlLines` adoption and
 * intentionally left as-is (#3266 slice 7 audit):
 *
 * | File | Reason skipped |
 * |------|---------------|
 * | `src/whatif/runner/tool-log.ts` | `parseLine` maps `RawToolLogEntry → ToolRequest` (value transform, not a pure predicate guard). |
 * | `src/agent/facets/derive.trace.ts` | Dual-accumulator with early-continue semantics; `parseJsonlLines` scans all lines. |
 * | `src/agent/facets/store.ts` | Break-after-first-meta semantics in `tryReadTraceSignals`; `parseJsonlLines` always scans all lines. |
 * | `src/agent/outcomes/session-end-hook.ts` | Return-after-first-closure semantics; same early-exit incompatibility. |
 * | `src/improve/scan/reader.ts` | Tracks per-line `lineNumber` (i+1) and counts both JSON and schema validation failures in `invalidLineCount`; `parseJsonlLines` has neither. |
 * | `src/whatif/episodes.ts` | Early-break on `isWhatifSession`; uses `parseRecord` domain transform, not raw `JSON.parse`. |
 * | `src/whatif/sandbox.home.ts` | Parses an `.env` key=value file with regex — not JSONL. |
 * | `src/improve/eval-gen/replay-fixture.ts` | Iterates byte-offset `lineRanges` by index; loop structure cannot be expressed as a guard predicate. |
 *
 * @module agent/daemon/telemetry-reader
 */

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

  // No existsSync guard: fsp.open on a missing file throws ENOENT, which is
  // caught by the outer catch block below and turns into an empty return.
  // A redundant existsSync check would introduce a TOCTOU window and is
  // unnecessary.
  let fd: fsp.FileHandle | null = null;
  try {
    fd = await fsp.open(telemetryPath, 'r');
    const stat = await fd.stat();
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    const readStart = fileSize > tailBytes ? fileSize - tailBytes : 0;
    const toRead = fileSize - readStart;
    const buf = Buffer.allocUnsafe(toRead);

    // POSIX allows short reads: a single fd.read() may return fewer bytes than
    // requested. Loop until all requested bytes are accumulated or the kernel
    // signals EOF (bytesRead === 0).
    let totalRead = 0;
    let readPos = readStart;
    while (totalRead < toRead) {
      const { bytesRead } = await fd.read(buf, totalRead, toRead - totalRead, readPos);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      readPos += bytesRead;
    }
    const content = buf.toString('utf8', 0, totalRead);

    const reader = new IncrementalLineReader();
    const lines = reader.feed(content);
    // Drain any trailing fragment (no trailing \n at end of tail window).
    const trailing = reader.flush();
    if (trailing.length > 0) lines.push(...trailing);

    // Explicit first-line discard.
    //
    // When readStart > 0 the tail seek may land mid-line, making the first
    // element of `lines` a truncated JSONL fragment that must be dropped.
    // However, if the byte immediately before readStart is '\n', the seek
    // landed exactly on a line boundary and the first element is a complete
    // record — in that case we keep it.
    //
    // When readStart === 0 we read the whole file; every line is complete.
    if (readStart > 0) {
      const prevBuf = Buffer.allocUnsafe(1);
      const { bytesRead: prevRead } = await fd.read(prevBuf, 0, 1, readStart - 1);
      const prevByteIsNewline = prevRead === 1 && prevBuf[0] === 0x0a;
      if (!prevByteIsNewline && lines.length > 0) {
        // Tail cut landed mid-line: first element is a truncated fragment.
        lines.shift();
      }
      // prevByteIsNewline === true: seek landed on a line boundary; keep first.
    }

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
    // ENOENT (file not found) and all other I/O errors are treated the same:
    // return an empty history. This is intentional — callers treat history as
    // best-effort and must not crash on a missing or unreadable telemetry file.
    return [];
  } finally {
    await fd?.close().catch(() => undefined);
  }
}
