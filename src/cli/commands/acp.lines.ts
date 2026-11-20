/**
 * Bounded NDJSON line splitter for the ACP stdio transport (profile §1).
 * Lines over the cap are discarded through their newline without buffering
 * them; invalid UTF-8 is reported rather than replaced.
 *
 * @module cli/commands/acp.lines
 */

import type { Readable } from 'node:stream';

export type InboundLine =
  | { kind: 'line'; text: string }
  | { kind: 'oversize' }
  | { kind: 'bad-utf8' };

const NEWLINE = 0x0a;

function decode(buf: Buffer): InboundLine {
  try {
    return { kind: 'line', text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { kind: 'bad-utf8' };
  }
}

/** Yield one entry per newline-terminated line (and a trailing partial line at EOF). */
export async function* readLines(input: Readable, maxBytes: number): AsyncGenerator<InboundLine> {
  let parts: Buffer[] = [];
  let size = 0;
  let oversize = false;
  for await (const raw of input) {
    let chunk: Buffer = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : (raw as Buffer);
    while (chunk.length > 0) {
      const nl = chunk.indexOf(NEWLINE);
      const piece = nl === -1 ? chunk : chunk.subarray(0, nl);
      if (!oversize) {
        if (size + piece.length > maxBytes) {
          oversize = true;
          parts = [];
          size = 0;
        } else {
          parts.push(piece);
          size += piece.length;
        }
      }
      if (nl === -1) break;
      yield oversize ? { kind: 'oversize' } : decode(Buffer.concat(parts, size));
      parts = [];
      size = 0;
      oversize = false;
      chunk = chunk.subarray(nl + 1);
    }
  }
  if (oversize) yield { kind: 'oversize' };
  else if (size > 0) yield decode(Buffer.concat(parts, size));
}
