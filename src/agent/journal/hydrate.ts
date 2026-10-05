/**
 * Hydration: resolve spilled `text_ref` / `ref` payloads back to inline
 * content so the result is ready for a provider adapter (types.ts: adapter
 * input is always hydrated).
 *
 * Invariant: never throws and never leaves a ref behind. A missing,
 * unreadable, size-mismatched, or path-escaping blob degrades to a TEXT
 * block/part naming what was lost (and, for text, carrying the stored
 * preview), so a resumed model sees an honest gap instead of a crash or a
 * silently vanished tool result.
 *
 * @module agent/journal/hydrate
 */

import { readBlob } from './blobs.js';
import type { BlobRef, JournalBinary, JournalBlock, JournalMessage, JournalResultPart } from './types.js';

type Text = { type: 'text'; text: string };

function describe(ref: BlobRef | undefined): string {
  if (!ref || typeof ref !== 'object') return 'unknown blob';
  return `${String(ref.path)} (${String(ref.mediaType)}, ${String(ref.bytes)} bytes)`;
}

function hydrateTextRef(ref: BlobRef, preview: string): Text {
  const data = readBlob(ref);
  if (data) return { type: 'text', text: data.toString('utf8') };
  const head = typeof preview === 'string' && preview.length > 0 ? `; preview follows]\n${preview}` : ']';
  return { type: 'text', text: `[journal: spilled text ${describe(ref)} is missing${head}` };
}

/** Inline binary source, or a text stand-in when the blob is gone. */
function hydrateBinary(source: JournalBinary, what: 'image' | 'document'): JournalBinary | Text {
  if (!source || source.kind !== 'ref') return source;
  const data = readBlob(source.ref);
  if (data) return { kind: 'base64', mediaType: source.ref.mediaType, data: data.toString('base64') };
  return { type: 'text', text: `[journal: ${what} ${describe(source.ref)} is missing]` };
}

function isText(v: JournalBinary | Text): v is Text {
  return (v as Text).type === 'text';
}

export function hydratePart(p: JournalResultPart): JournalResultPart {
  switch (p.type) {
    case 'text_ref':
      return hydrateTextRef(p.ref, p.preview);
    case 'image': {
      const s = hydrateBinary(p.source, 'image');
      if (isText(s)) return s;
      return s === p.source ? p : { ...p, source: s };
    }
    case 'document': {
      const s = hydrateBinary(p.source, 'document');
      if (isText(s)) return s;
      return s === p.source ? p : { ...p, source: s };
    }
    default:
      return p;
  }
}

export function hydrateBlock(b: JournalBlock): JournalBlock {
  switch (b.type) {
    case 'text_ref':
      return hydrateTextRef(b.ref, b.preview);
    case 'image': {
      const s = hydrateBinary(b.source, 'image');
      if (isText(s)) return s;
      return s === b.source ? b : { ...b, source: s };
    }
    case 'document': {
      const s = hydrateBinary(b.source, 'document');
      if (isText(s)) return s;
      return s === b.source ? b : { ...b, source: s };
    }
    case 'tool_result':
      return Array.isArray(b.content) ? { ...b, content: b.content.map(hydratePart) } : b;
    default:
      return b;
  }
}

export function hydrateMessage(m: JournalMessage): JournalMessage {
  return { ...m, content: Array.isArray(m.content) ? m.content.map(hydrateBlock) : [] };
}
