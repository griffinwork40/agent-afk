import type { JsonValue, ToolCallContent, ToolCallStart } from './acp.wire.js';

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

/** Display metadata must not bypass raw-input/result transport budgets. */
export function boundStartDisplay(start: ToolCallStart): ToolCallStart {
  // A title is one line: control characters and line separators become spaces.
  start.title = start.title.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
  if (serializedBytes(start.title) > 4096) start.title = 'Tool call';
  if (start.locations && serializedBytes(start.locations) > COLLECTION_BYTES) start.locations = [];
  return start;
}
