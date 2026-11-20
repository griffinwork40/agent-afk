import type { JsonValue, ToolCallContent, ToolCallStart } from './acp.wire.js';
import { escapeInvisible } from './acp.tool-title.js';

const RESULT_BYTES = 65536;
// Reserve space for worst-case JSON escaping of rawOutput AND text content,
// plus envelope, ids and status. Collections/raw input get independent budgets.
const COLLECTION_BYTES = 131072;
const marker = '\n[truncated]';

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function parseToolInput(raw: string | undefined): JsonValue | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    // JSON.parse accepts overflowing numbers such as 1e400. Do not expose
    // Infinity as a measured numeric input (JSON serialization turns it null).
    JSON.stringify(value, (_key: string, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Nonfinite input');
      return item;
    });
    return value as JsonValue;
  } catch { return undefined; }
}

export function boundedRawInput(input: JsonValue | undefined): JsonValue | undefined {
  return input !== undefined && serializedBytes(input) <= COLLECTION_BYTES ? input : undefined;
}

export function boundedResult(text: string): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= RESULT_BYTES) return text;
  let end = RESULT_BYTES - Buffer.byteLength(marker);
  // Back up to the first byte of any code point split by the byte budget.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8') + marker;
}

export function isDiffOmission(item: ToolCallContent): boolean {
  return item.type === 'content' && item.content.type === 'text' && item.content.text === 'Diff omitted: exceeds transport limit';
}

export function boundedContent(content: ToolCallContent[]): ToolCallContent[] {
  const diffs = content.filter(item => item.type === 'diff');
  if (!content.some(isDiffOmission) && serializedBytes(diffs) <= COLLECTION_BYTES) return content;
  return [
    { type: 'content', content: { type: 'text', text: 'Diff omitted: exceeds transport limit' } },
    ...content.filter(item => item.type !== 'diff' && !isDiffOmission(item)),
  ];
}

// Contract: Every human-display field of every agent-to-client frame must pass
// through escapeInvisible before the frame is written. This function is the ONE
// choke point that guarantees that; applying it twice is safe because the escape
// is idempotent (the replacement string '<U+XXXX>' contains only printable ASCII
// and is therefore left unchanged on a second pass).
//
// Frame types emitted by the server and their display fields:
//   tool_call (ToolCallStart)        — title, locations[].path
//   tool_call_update (ToolCallUpdate) — title (when present), locations[].path (when present)
//   session/request_permission        — toolCall.title, toolCall.locations[].path, options[].name
//
// Fields that are DATA (byte-exact, never shown verbatim to the human as the
// action description) are NOT touched here: rawInput, rawOutput, content (message
// text, tool output, diffs), toolCallId, sessionId, name (tool identifier),
// kind, status, optionId.  The permission option name IS display text.
//
// Inner escaping (oneLine, shellCommandLine, toolTitle) is preserved because it
// must count toward byte bounds and because outside-path and sensitive markers
// must survive bounding correctly.  This outer pass is what guarantees coverage
// for strings assembled or appended after the inner pass runs.
/** Display metadata must not bypass raw-input/result transport budgets. */
export function boundStartDisplay(start: ToolCallStart): ToolCallStart {
  // A title is one line: control characters and line separators become spaces,
  // then bidi/invisible/tag/Cf chars are replaced with visible escape notation.
  // This second pass covers strings appended after toolTitle (e.g. D10 outside
  // paths from buildPendingStart) which bypass oneLine's own escaping pass.
  start.title = escapeInvisible(
    start.title.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' '),
  );
  if (serializedBytes(start.title) > 4096) start.title = 'Tool call';
  // Escape every path in locations — a filename may legally contain bidi
  // controls on Linux/macOS and would otherwise mislead the card display.
  if (start.locations) {
    start.locations = start.locations.map((loc) => ({
      ...loc,
      path: escapeInvisible(loc.path.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')),
    }));
  }
  if (start.locations && serializedBytes(start.locations) > COLLECTION_BYTES) start.locations = [];
  return start;
}

const cleanDisplay = (s: string): string => escapeInvisible(s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' '));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Write-boundary pass: applied to the params of every `session/update` and
 * `session/request_permission` immediately before they are written, so a
 * display string cannot leave the server unescaped however the frame was
 * built. Covers `title`, `locations[].path` and `options[].name`, on the frame
 * itself and on a nested `update` or `toolCall`. Idempotent (an escape is plain
 * ASCII), so the inner passes above stay correct. Data fields are not touched.
 */
export function sanitizeDisplay<T>(value: T): T {
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  if (typeof out['title'] === 'string') out['title'] = cleanDisplay(out['title']);
  if (Array.isArray(out['locations'])) {
    out['locations'] = out['locations'].map((l: unknown) => (isObject(l) && typeof l['path'] === 'string' ? { ...l, path: cleanDisplay(l['path']) } : l));
  }
  if (Array.isArray(out['options'])) {
    out['options'] = out['options'].map((o: unknown) => (isObject(o) && typeof o['name'] === 'string' ? { ...o, name: cleanDisplay(o['name']) } : o));
  }
  if (isObject(out['update'])) out['update'] = sanitizeDisplay(out['update']);
  if (isObject(out['toolCall'])) out['toolCall'] = sanitizeDisplay(out['toolCall']);
  return out as T;
}
