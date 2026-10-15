/**
 * Render a journal `tool_result` block as display text.
 *
 * Shared by the web server's lazy tool-result endpoint and
 * `afk trace show --results`, so both surfaces show the same bytes for the
 * same call. Pure: takes an already-hydrated block (see
 * `findToolResult` in src/agent/journal) and never touches disk.
 *
 * @module web-server/tool-result-text
 */

import type { JournalBinary, JournalBlock, JournalResultPart } from '../agent/journal/index.js';

export type JournalToolResultBlock = Extract<JournalBlock, { type: 'tool_result' }>;

function fmtKb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function binaryLabel(kind: 'image' | 'document', source: JournalBinary, title?: string): string {
  const name = title ? ` "${title}"` : '';
  switch (source.kind) {
    case 'base64':
      // base64 inflates 4:3; report the decoded size.
      return `[${kind}${name}: ${source.mediaType}, ${fmtKb(Math.floor((source.data.length * 3) / 4))}]`;
    case 'url':
      return `[${kind}${name}: ${source.url}]`;
    case 'ref':
      return `[${kind}${name}: ${source.ref.mediaType}, ${fmtKb(source.ref.bytes)}]`;
  }
}

function partText(part: JournalResultPart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'text_ref':
      // Hydration should have inlined this; if it did not, say so rather than
      // presenting the preview as the whole result.
      return `${part.preview}\n[… spilled text not hydrated: ${fmtKb(part.ref.bytes)} at ${part.ref.path}]`;
    case 'image':
      return binaryLabel('image', part.source);
    case 'document':
      return binaryLabel('document', part.source, part.title);
  }
}

/**
 * Contract: text parts are concatenated verbatim (joined by a newline between
 * parts); binary parts become a one-line `[image: …]` / `[document: …]`
 * placeholder. Base64 payloads are never emitted — a screenshot would
 * otherwise flood a terminal or a JSON response with megabytes of noise.
 */
export function toolResultToText(block: JournalToolResultBlock): string {
  return block.content.map(partText).join('\n');
}
