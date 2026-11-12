/** Deadline-aware, size-bounded input for SessionEnd outcomes. No whole-file sync I/O. */
import { createReadStream } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { getSessionJournalPath, isSafeLedgerSessionId } from '../../paths.js';
import { getSessionMetaPath } from '../../paths.journal.js';
import { isEnoent } from '../../utils/errors.js';
import { parseJournalLine } from '../journal/records.js';
import { resolveBlobPath } from '../journal/blobs.js';
import { journalRecordsToToolEvents } from '../facets/journal-adapter.js';
import type { JournalMessage, JournalRecord } from '../journal/types.js';
import type { SessionMeta } from '../session/session-meta.js';

export interface InputBudget {
  signal: AbortSignal;
  deadline: number;
}

export function checkBudget(budget: InputBudget): void {
  budget.signal.throwIfAborted();
  if (Date.now() >= budget.deadline) throw new Error('outcomes input deadline exceeded');
}

/** Caps also bound individual JSON.parse calls; exhaustion fails the computation, not partial success. */
export async function* boundedLines(
  path: string, budget: InputBudget, maxBytes = 32 * 1024 * 1024,
): AsyncGenerator<string> {
  checkBudget(budget);
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 16 * 1024, signal: budget.signal });
  let pending = '';
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      checkBudget(budget);
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes) throw new Error('outcomes input byte limit exceeded');
      pending += text;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 256 * 1024) throw new Error('outcomes input line limit exceeded');
        yield pending.slice(0, end);
        pending = pending.slice(end + 1);
      }
      if (pending.length > 256 * 1024) throw new Error('outcomes input line limit exceeded');
      // Yield even for cached disk input so deadline timers and other hooks run.
      await setImmediate(undefined, { signal: budget.signal });
    }
    if (pending) yield pending;
    checkBudget(budget);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  } finally {
    stream.destroy();
  }
}

export async function readOutcomesMeta(sessionId: string, budget: InputBudget): Promise<SessionMeta | null> {
  if (!isSafeLedgerSessionId(sessionId)) return null;
  let text = '';
  for await (const line of boundedLines(getSessionMetaPath(sessionId), budget, 64 * 1024)) text += line;
  if (!text) return null;
  const meta = JSON.parse(text) as SessionMeta;
  return meta.v === 1 && meta.sessionId === sessionId ? meta : null;
}

async function assistantText(message: JournalMessage, budget: InputBudget): Promise<string> {
  let text = '';
  for (const block of message.content) {
    checkBudget(budget);
    if (block.type === 'text') text += block.text;
    if (block.type === 'text_ref') {
      const path = resolveBlobPath(block.ref);
      if (!path) throw new Error('unsafe outcomes text blob');
      let hydrated = '';
      for await (const line of boundedLines(path, budget, 256 * 1024)) hydrated += `${line}\n`;
      text += hydrated || block.preview;
    }
    if (text.length > 256 * 1024) throw new Error('outcomes assistant text limit exceeded');
  }
  return text;
}

/** One journal pass: all tool evidence, plus the folded final assistant message. */
export async function readOutcomesJournal(sessionId: string, budget: InputBudget) {
  if (!isSafeLedgerSessionId(sessionId)) return { toolEvents: [], lastAssistantMessage: null };
  const records: JournalRecord[] = [];
  const messages: JournalMessage[] = [];
  for await (const line of boundedLines(getSessionJournalPath(sessionId), budget)) {
    checkBudget(budget);
    const rec = parseJournalLine(line);
    if (!rec) continue;
    records.push(rec);
    if (records.length > 20_000) throw new Error('outcomes journal record limit exceeded');
    if (rec.kind === 'truncate') messages.length = Math.min(messages.length, rec.length);
    if (rec.kind === 'append') {
      messages.length = Math.min(messages.length, rec.index);
      messages.push(rec.message);
    }
  }
  checkBudget(budget);
  const toolEvents = journalRecordsToToolEvents(records, { checkBudget: () => checkBudget(budget) });
  let lastAssistantMessage: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const text = await assistantText(message, budget);
    if (text) { lastAssistantMessage = text; break; }
  }
  checkBudget(budget);
  return { toolEvents, lastAssistantMessage };
}
