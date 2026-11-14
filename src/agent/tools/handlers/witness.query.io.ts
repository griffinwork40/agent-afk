/**
 * Low-level trace I/O for witness query.
 *
 * Extracted from witness.query.ts to satisfy the 350-line ceiling.
 * Owns the byte-capped `readTraceSafe` helper and its result type.
 *
 * @module agent/tools/handlers/witness.query.io
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** Max bytes to read from a single trace file. Prevents OOM on huge traces. */
export const MAX_READ_BYTES = 2_097_152; // 2 MB

/** Result from readTraceSafe: content and whether the file was byte-capped. */
export interface ReadTraceSafeResult {
  content: string;
  truncated: boolean;
}

/** Read a trace.jsonl file with a byte-size cap (async). */
export async function readTraceSafe(tracePath: string): Promise<ReadTraceSafeResult> {
  if (!existsSync(tracePath)) return { content: '', truncated: false };
  try {
    const buf = await readFile(tracePath);
    if (buf.length <= MAX_READ_BYTES) {
      // Non-truncated path: the full buffer is returned as-is. No FFFD
      // stripping is needed here because we convert the whole buffer; Node's
      // Buffer.toString('utf-8') only produces U+FFFD when a sequence is split
      // across a subarray boundary, which cannot happen on a complete file read.
      return { content: buf.toString('utf-8'), truncated: false };
    }
    // Slice from the tail then align to the next newline boundary to avoid
    // splitting a multi-byte UTF-8 sequence or a partial JSON object.
    // Newline realignment eliminates mid-codepoint splits introduced by the
    // tail slice itself (orphaned continuation bytes at the window start are
    // discarded). A trailing U+FFFD can still appear when the file itself ends
    // mid-codepoint (e.g. an interrupted final write); strip it for consistency
    // with other truncation sites (journal.ts, bg-result-notifier.ts).
    let capped = buf.subarray(buf.length - MAX_READ_BYTES);
    const firstNewline = capped.indexOf(0x0a);
    if (firstNewline !== -1) {
      capped = capped.subarray(firstNewline + 1);
    }
    return { content: capped.toString('utf-8').replace(/\uFFFD+$/, ''), truncated: true };
  } catch {
    return { content: '', truncated: false };
  }
}
