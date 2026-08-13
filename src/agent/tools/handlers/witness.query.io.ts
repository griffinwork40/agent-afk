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
      return { content: buf.toString('utf-8'), truncated: false };
    }
    // Slice from the tail then align to the next newline boundary to avoid
    // splitting a multi-byte UTF-8 sequence or a partial JSON object.
    let capped = buf.subarray(buf.length - MAX_READ_BYTES);
    const firstNewline = capped.indexOf(0x0a);
    if (firstNewline !== -1) {
      capped = capped.subarray(firstNewline + 1);
    }
    return { content: capped.toString('utf-8'), truncated: true };
  } catch {
    return { content: '', truncated: false };
  }
}
