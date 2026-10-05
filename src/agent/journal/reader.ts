/**
 * Message-journal read side (docs/message-journal.md): existence, record
 * parsing, the pure fold, hydration, resume load, and tool-result lookup.
 *
 * Posture: every function here is non-throwing. Unsafe session / subagent ids
 * read as "no journal"; unreadable files read as absent; malformed lines are
 * skipped. The journal is audit + resume input, and neither may crash the
 * caller (resume falls back to the sidecar path on `null`).
 *
 * @module agent/journal/reader
 */

import * as fs from 'node:fs';

import {
  getSessionJournalPath,
  getSubagentJournalPath,
  getSubagentJournalsDir,
  isSafeLedgerSessionId,
} from '../../paths.js';
import { hydrateBlock, hydrateMessage } from './hydrate.js';
import { readJournalFile, type JournalFileRead } from './records.js';
import type { JournalBlock, JournalMessage, JournalRecord, ToolResultLookup } from './types.js';
import { isMessageJournalDisabled } from './noop.js';

export interface JournalLocator {
  /** Read `subagents/<subagentId>.jsonl` instead of the top-level journal. */
  subagentId?: string;
}

export interface FoldResult {
  messages: JournalMessage[];
  /**
   * The FIRST `meta` record (the journal's origin; carries `forkedFrom`).
   * Later metas come from resumed writers and are only counted for anomalies.
   */
  meta: Extract<JournalRecord, { kind: 'meta' }> | undefined;
  /** Non-fatal inconsistencies (bad lines, index gaps from concurrent writers). */
  anomalies: string[];
}

/** Absolute journal path, or null for an unsafe id. */
function locate(sessionId: string, loc: JournalLocator): string | null {
  if (typeof sessionId !== 'string' || !isSafeLedgerSessionId(sessionId)) return null;
  try {
    return loc.subagentId === undefined
      ? getSessionJournalPath(sessionId)
      : getSubagentJournalPath(sessionId, loc.subagentId);
  } catch {
    return null;
  }
}

function readFile(sessionId: string, loc: JournalLocator): JournalFileRead | null {
  const path = locate(sessionId, loc);
  return path ? readJournalFile(path) : null;
}

export function journalExists(sessionId: string, loc: JournalLocator = {}): boolean {
  const path = locate(sessionId, loc);
  if (!path) return false;
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Parse every record; malformed lines are skipped (reported via fold anomalies). */
export function readJournalRecords(sessionId: string, loc: JournalLocator = {}): JournalRecord[] {
  return readFile(sessionId, loc)?.records ?? [];
}

/** Pure fold of records into the message array (see types.ts invariant). */
export function foldJournal(records: readonly JournalRecord[]): FoldResult {
  const messages: JournalMessage[] = [];
  const anomalies: string[] = [];
  let meta: FoldResult['meta'];
  records.forEach((rec, i) => {
    switch (rec.kind) {
      case 'meta':
        if (!meta) meta = rec;
        return;
      case 'append':
        if (rec.index === messages.length) {
          messages.push(rec.message);
        } else if (rec.index < messages.length) {
          anomalies.push(`record ${i}: append at index ${rec.index} while length ${messages.length}; overwrote`);
          messages.length = rec.index;
          messages.push(rec.message);
        } else {
          anomalies.push(`record ${i}: append at index ${rec.index} past length ${messages.length}; appended at end`);
          messages.push(rec.message);
        }
        return;
      case 'truncate':
        if (rec.length > messages.length) {
          anomalies.push(`record ${i}: truncate to ${rec.length} past length ${messages.length}; ignored`);
        } else {
          messages.length = rec.length;
        }
        return;
      default:
        return;
    }
  });
  return { messages, meta, anomalies };
}

/** Fold one journal file, adding a malformed-line anomaly. `null` when absent. */
export function loadJournalFold(sessionId: string, loc: JournalLocator = {}): FoldResult | null {
  const file = readFile(sessionId, loc);
  if (!file || !file.exists) return null;
  const fold = foldJournal(file.records);
  if (file.malformedLines > 0) fold.anomalies.unshift(`${file.malformedLines} malformed line(s) skipped`);
  return fold;
}

/**
 * Resolve every `text_ref` / `ref` source back to inline content. A missing
 * or unreadable blob becomes a text part naming what was lost; never throws.
 */
export function hydrateMessages(messages: readonly JournalMessage[]): JournalMessage[] {
  return messages.map(hydrateMessage);
}

/** Fold + hydrate. `null` when the journal is absent, disabled, or empty. */
export function loadJournalMessages(sessionId: string, loc: JournalLocator = {}): JournalMessage[] | null {
  if (isMessageJournalDisabled()) return null;
  const fold = loadJournalFold(sessionId, loc);
  if (!fold || fold.messages.length === 0) return null;
  return hydrateMessages(fold.messages);
}

type ToolResultBlock = Extract<JournalBlock, { type: 'tool_result' }>;

/** Newest (by ts, then file order) tool_result for `toolUseId` in one record list. */
function scanForToolResult(
  records: readonly JournalRecord[],
  toolUseId: string,
): { block: ToolResultBlock; ts: number } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]!;
    if (rec.kind !== 'append') continue;
    const content = rec.message.content;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j]!;
      if (b.type === 'tool_result' && b.toolUseId === toolUseId) return { block: b, ts: rec.ts };
    }
  }
  return null;
}

/**
 * Find a tool_result by tool_use id across the top-level journal and every
 * subagent journal of the session, hydrated. Scans all records (not just the
 * folded array), so results removed by compaction are still found.
 */
export function findToolResult(
  sessionId: string,
  toolUseId: string,
): ToolResultLookup | null {
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null;
  let best: { block: ToolResultBlock; ts: number; subagentId?: string } | null = null;
  const locators: JournalLocator[] = [{}, ...listSubagentJournals(sessionId).map((subagentId) => ({ subagentId }))];
  for (const loc of locators) {
    const hit = scanForToolResult(readJournalRecords(sessionId, loc), toolUseId);
    if (hit && (!best || hit.ts > best.ts)) {
      best = { ...hit, ...(loc.subagentId !== undefined ? { subagentId: loc.subagentId } : {}) };
    }
  }
  if (!best) return null;
  const block = hydrateBlock(best.block) as ToolResultBlock;
  return best.subagentId !== undefined ? { block, subagentId: best.subagentId } : { block };
}

/** Subagent ids that have a journal under this session. */
export function listSubagentJournals(sessionId: string): string[] {
  if (typeof sessionId !== 'string' || !isSafeLedgerSessionId(sessionId)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(getSubagentJournalsDir(sessionId));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (locate(sessionId, { subagentId: id })) ids.push(id);
  }
  return ids.sort();
}
