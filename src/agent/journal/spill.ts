/**
 * Spill policy (docs/message-journal.md): applied to a message before its
 * `append` record is serialized.
 *
 *   - A `text` block or tool_result `text` part larger than
 *     {@link SPILL_TEXT_BYTES} (UTF-8) → `blobs/<sha256>.txt` +
 *     `text_ref { ref, preview }`, preview = first {@link PREVIEW_CHARS} chars.
 *   - Every base64 image/document source → decoded bytes to
 *     `blobs/<sha256>.<ext>` + `{ kind: 'ref', ref }`.
 *
 * Pure apart from hashing: returns a NEW message (unchanged blocks are shared
 * by reference, the input is never mutated) plus the blobs that must be on
 * disk before the record is written.
 *
 * @module agent/journal/spill
 */

import { createHash } from 'node:crypto';

import { makePendingBlob, type PendingBlob } from './blobs.js';
import type { JournalBinary, JournalBlock, JournalMessage, JournalResultPart } from './types.js';

export const SPILL_TEXT_BYTES = 32 * 1024;
export const PREVIEW_CHARS = 2 * 1024;

export interface SpillResult {
  message: JournalMessage;
  blobs: PendingBlob[];
}

class Spiller {
  readonly blobs: PendingBlob[] = [];
  constructor(private readonly sessionId: string) {}

  private add(data: Buffer, mediaType: string): PendingBlob {
    const sha = createHash('sha256').update(data).digest('hex');
    const blob = makePendingBlob(this.sessionId, sha, data, mediaType);
    if (!this.blobs.some((b) => b.absPath === blob.absPath)) this.blobs.push(blob);
    return blob;
  }

  /** `text_ref` replacement for oversized text, or null to keep it inline. */
  text(text: string): { type: 'text_ref'; ref: PendingBlob['ref']; preview: string } | null {
    if (Buffer.byteLength(text, 'utf8') <= SPILL_TEXT_BYTES) return null;
    const blob = this.add(Buffer.from(text, 'utf8'), 'text/plain');
    return { type: 'text_ref', ref: blob.ref, preview: text.slice(0, PREVIEW_CHARS) };
  }

  binary(source: JournalBinary): JournalBinary {
    if (source.kind !== 'base64') return source;
    const blob = this.add(Buffer.from(source.data, 'base64'), source.mediaType);
    return { kind: 'ref', ref: blob.ref };
  }

  part(p: JournalResultPart): JournalResultPart {
    switch (p.type) {
      case 'text':
        return this.text(p.text) ?? p;
      case 'image':
        return p.source.kind === 'base64' ? { ...p, source: this.binary(p.source) } : p;
      case 'document':
        return p.source.kind === 'base64' ? { ...p, source: this.binary(p.source) } : p;
      default:
        return p;
    }
  }

  block(b: JournalBlock): JournalBlock {
    switch (b.type) {
      case 'text':
        return this.text(b.text) ?? b;
      case 'image':
        return b.source.kind === 'base64' ? { ...b, source: this.binary(b.source) } : b;
      case 'document':
        return b.source.kind === 'base64' ? { ...b, source: this.binary(b.source) } : b;
      case 'tool_result': {
        if (!Array.isArray(b.content)) return b;
        const content = b.content.map((p) => this.part(p));
        return content.every((p, i) => p === b.content[i]) ? b : { ...b, content };
      }
      default:
        return b;
    }
  }
}

/** Apply the spill policy for a message about to be journaled under `sessionId`. */
export function spillMessage(sessionId: string, message: JournalMessage): SpillResult {
  const s = new Spiller(sessionId);
  const content = Array.isArray(message.content) ? message.content.map((b) => s.block(b)) : message.content;
  const changed = s.blobs.length > 0 || content.some((b, i) => b !== message.content[i]);
  return { message: changed ? { ...message, content } : message, blobs: s.blobs };
}
