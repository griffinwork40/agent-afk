/**
 * On-disk record parsing + length arithmetic shared by the writer (resume
 * length) and the reader (fold). Pure except {@link readJournalFile}.
 *
 * Invariant: {@link nextLength} is the single definition of how one record
 * moves the folded length. `foldJournal` and the writer's in-memory `length`
 * both follow it, so a resumed writer appends exactly where the fold ends,
 * including the tolerant cases (an append whose index is not the current
 * length, a truncate past the end).
 *
 * @module agent/journal/records
 */

import * as fs from 'node:fs';

import { JOURNAL_VERSION, type JournalRecord, type JournalRecordInput } from './types.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Invariant: validate each recognized block shape against what this codebase
 * writes/reads (types.ts JournalBlock). A syntactically valid JSONL line
 * whose blocks are missing required fields (e.g. tool_result without
 * toolUseId, or with non-array content) would reach provider adapters or
 * hydrate.ts and throw. Unknown block types are rejected; they belong to a
 * future schema version that this reader cannot safely fold. The non-throwing
 * malformed-line contract (parseJournalLine → null) is preserved: invalid
 * blocks make isMessage return false, which makes isValidRecord return false,
 * which returns null rather than throwing.
 */
function isBlock(b: unknown): boolean {
  if (!isObject(b)) return false;
  switch (b['type']) {
    case 'text':
      return typeof b['text'] === 'string';
    case 'text_ref':
      return isObject(b['ref']) && typeof b['preview'] === 'string';
    case 'thinking':
      return typeof b['thinking'] === 'string';
    case 'redacted_thinking':
      return typeof b['data'] === 'string';
    case 'tool_use':
      return typeof b['id'] === 'string' && typeof b['name'] === 'string' && 'input' in b;
    case 'tool_result':
      // content is always JournalResultPart[] in this codebase (the adapter
      // converts Anthropic's string shorthand to [{ type:'text', text }]).
      return typeof b['toolUseId'] === 'string' && Array.isArray(b['content']);
    case 'image':
      return isObject(b['source']);
    case 'document':
      return isObject(b['source']);
    default:
      return false;
  }
}

function isMessage(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (v['role'] !== 'user' && v['role'] !== 'assistant') return false;
  const content = v['content'];
  return Array.isArray(content) && content.every(isBlock);
}

function isValidRecord(p: Record<string, unknown>): boolean {
  switch (p['kind']) {
    case 'meta':
      return typeof p['sessionId'] === 'string' && typeof p['writerId'] === 'string';
    case 'append':
      return isIndex(p['index']) && isMessage(p['message']);
    case 'truncate':
      return isIndex(p['length']);
    case 'mark':
      return typeof p['label'] === 'string';
    default:
      return false;
  }
}

/** Parse one JSONL line. `null` for blank, malformed, or wrong-version lines. */
export function parseJournalLine(line: string): JournalRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed['v'] !== JOURNAL_VERSION || typeof parsed['ts'] !== 'number') return null;
  return isValidRecord(parsed) ? (parsed as unknown as JournalRecord) : null;
}

export interface JournalFileRead {
  exists: boolean;
  records: JournalRecord[];
  /** Non-blank lines that failed to parse (torn tail, hand edits, future versions). */
  malformedLines: number;
  /** False when the file ends mid-line (a torn write); the writer repairs with '\n'. */
  endsWithNewline: boolean;
}

/** Synchronous whole-file read. Any read error reads as an absent file. */
export function readJournalFile(path: string): JournalFileRead {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return { exists: false, records: [], malformedLines: 0, endsWithNewline: true };
  }
  const records: JournalRecord[] = [];
  let malformedLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const rec = parseJournalLine(line);
    if (rec) records.push(rec);
    else malformedLines++;
  }
  return { exists: true, records, malformedLines, endsWithNewline: text.length === 0 || text.endsWith('\n') };
}

type LengthInput = JournalRecord | JournalRecordInput;

/**
 * Folded length after one record. An append at `index <= len` lands at
 * `index` (dropping anything after it); an append past the end lands at the
 * end (no holes). A truncate never extends.
 */
export function nextLength(len: number, rec: LengthInput): number {
  if (rec.kind === 'append') return rec.index <= len ? rec.index + 1 : len + 1;
  if (rec.kind === 'truncate') return Math.min(len, rec.length);
  return len;
}

/** Folded length of a whole record list. */
export function foldLength(records: readonly LengthInput[]): number {
  let len = 0;
  for (const r of records) len = nextLength(len, r);
  return len;
}
