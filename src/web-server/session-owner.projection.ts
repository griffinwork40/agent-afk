/** Rebuild the browser projection from the durable, human-visible journal.
 * Never use the model fold: compaction summaries are not transcript rows.
 */
import { getSessionJournalPath } from '../paths.js';
import { hydrateMessages, loadDisplayMessages, loadJournalFold } from '../agent/journal/index.js';
import { hasToolResultBlock, messageText } from '../agent/content/user-authored.js';
import { clip, MAX_ASSISTANT_TEXT_LEN, MAX_TEXT_LEN, MAX_TOOL_INPUT_LEN } from '../agent/session-ledger-project.js';
import { readLedger } from '../agent/session-ledger.js';
import { isPreamble, extractUserContent } from '../agent/session/preamble-strip.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { JournalMessage } from '../agent/journal/index.js';
import type { LedgerPayload } from '../agent/session-ledger.js';

/**
 * Read cost totals accumulated across all `done` records in a session ledger.
 *
 * Contract: called BEFORE the ledger is archived/replaced so that Retry and
 * /rewind can carry billing metadata into the rebuilt projection.  The journal
 * itself contains no billing data (journals record conversation content only),
 * so this is the sole source of truth for per-turn cost after a rewind.
 *
 * Never throws — a missing or unreadable ledger simply returns zero totals.
 */
export async function readLedgerCostTotals(sessionId: string): Promise<{
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}> {
  const totals = { costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  try {
    for await (const rec of readLedger(sessionId)) {
      if (rec.kind !== 'done') continue;
      if (typeof rec.costUsd === 'number') totals.costUsd += rec.costUsd;
      if (typeof rec.durationMs === 'number') totals.durationMs += rec.durationMs;
      if (typeof rec.inputTokens === 'number') totals.inputTokens += rec.inputTokens;
      if (typeof rec.outputTokens === 'number') totals.outputTokens += rec.outputTokens;
      if (typeof rec.cacheReadTokens === 'number') totals.cacheReadTokens += rec.cacheReadTokens;
    }
  } catch {
    // Unreadable ledger — return whatever was accumulated so far.
  }
  return totals;
}

/**
 * Per-tool wall-clock durations recorded in the CURRENT ledger, keyed by
 * toolUseId.
 *
 * Contract: like cost, durations live only in the ledger (`tool_result`
 * records carry `durationMs`); the journal has none. Read BEFORE the ledger is
 * archived so Retry / /rewind can carry them into the rebuilt projection.
 * A tool missing from the map gets no duration (never a guessed one).
 * Never throws: an unreadable ledger returns what was read so far.
 */
export async function readLedgerToolDurations(sessionId: string): Promise<Map<string, number>> {
  const durations = new Map<string, number>();
  try {
    for await (const rec of readLedger(sessionId)) {
      if (rec.kind === 'tool_result' && typeof rec.durationMs === 'number') durations.set(rec.toolUseId, rec.durationMs);
    }
  } catch {
    // Unreadable ledger: keep whatever was accumulated.
  }
  return durations;
}

/** Check BEFORE mutation too: a disabled/failed journal cannot safely rewind web. */
export async function readProjectionMessages(session: AgentSession): Promise<JournalMessage[]> {
  const journal = session.messageJournal;
  const id = session.sessionId;
  if (!journal || !id) throw new Error('Cannot rewind web transcript: message journal unavailable.');
  await journal.flush();
  const fold = loadJournalFold(id);
  if (journal.path !== getSessionJournalPath(id) || !fold || fold.anomalies.length || fold.messages.length !== journal.length) {
    throw new Error('Cannot rewind web transcript: message journal is not durable or consistent.');
  }
  return hydrateMessages(loadDisplayMessages(id));
}

/**
 * Per-turn cost totals from the pre-rewind ledger.  When provided, the cost is
 * distributed across the projected `done` records so the browser meter does not
 * reset to zero after Retry or /rewind.
 *
 * Contract: the totals come from `readLedgerCostTotals`, which sums every
 * `done` record in the CURRENT ledger BEFORE it is archived.  After the rewind,
 * the new ledger starts empty, so without this injection the header meter drops
 * to $0 even though the underlying API cost was already incurred.
 *
 * Distribution strategy: attribute all cost to the LAST `done` record in the
 * retained projection, matching the shape of a real ledger where a multi-tool
 * turn accumulates all billing in one `done` event.
 */
export type LedgerCostTotals = {
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export function projectJournalMessages(
  messages: readonly JournalMessage[],
  priorCost?: LedgerCostTotals,
  toolDurations?: ReadonlyMap<string, number>,
): LedgerPayload[] {
  const records: LedgerPayload[] = [];
  const tools = new Map<string, string>();
  let turn = false;
  for (const message of messages) {
    if (message.role === 'user' && !hasToolResultBlock(message.content)) {
      if (turn) records.push({ kind: 'done' });
      turn = true;
      const raw = messageText(message.content, '\n') || message.content.map((b) => `[${b.type}]`).join(' ');
      // Strip framework-injected preamble ([placeholder-prevent], [jev rules],
      // skill dispatch XML, bridge context, etc.) before writing to the browser
      // projection so the /rewind picker and the transcript show only what the
      // user actually typed.
      const text = isPreamble(raw) ? (extractUserContent(raw) ?? raw) : raw;
      records.push({ kind: 'user', text: clip(text, MAX_TEXT_LEN) });
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (message.role === 'assistant') records.push({ kind: 'assistant', text: clip(block.text, MAX_ASSISTANT_TEXT_LEN) });
          break;
        case 'thinking':
          records.push({ kind: 'thinking', text: clip(block.thinking, MAX_TEXT_LEN) });
          break;
        case 'tool_use':
          tools.set(block.id, block.name);
          records.push({ kind: 'tool', toolName: block.name, toolUseId: block.id, input: clip(JSON.stringify(block.input) ?? '', MAX_TOOL_INPUT_LEN) });
          break;
        case 'tool_result': {
          const content = clip(block.content.map((p) => p.type === 'text' ? p.text : `[${p.type}]`).join('\n'), MAX_TOOL_INPUT_LEN);
          const toolName = tools.get(block.toolUseId);
          records.push(block.isError
            ? { kind: 'tool_error', content, ...(toolName ? { toolName } : {}) }
            : { kind: 'tool_result', toolUseId: block.toolUseId, content, ...(durationOf(toolDurations, block.toolUseId)), ...(toolName ? { toolName } : {}) });
          break;
        }
      }
    }
  }
  if (!turn) return records;
  // Invariant: carry pre-rewind billing totals into the LAST done record so the
  // browser meter shows the cumulative session cost rather than resetting to $0.
  // Journals hold no billing metadata, so we inject it from the archived ledger.
  if (priorCost && priorCost.costUsd > 0) {
    records.push({
      kind: 'done',
      costUsd: priorCost.costUsd,
      ...(priorCost.durationMs > 0 ? { durationMs: priorCost.durationMs } : {}),
      ...(priorCost.inputTokens > 0 ? { inputTokens: priorCost.inputTokens } : {}),
      ...(priorCost.outputTokens > 0 ? { outputTokens: priorCost.outputTokens } : {}),
      ...(priorCost.cacheReadTokens > 0 ? { cacheReadTokens: priorCost.cacheReadTokens } : {}),
    });
  } else {
    records.push({ kind: 'done' });
  }
  return records;
}

/** `{ durationMs }` only when the pre-rewind ledger recorded one for this tool. */
function durationOf(durations: ReadonlyMap<string, number> | undefined, toolUseId: string): { durationMs?: number } {
  const ms = durations?.get(toolUseId);
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? { durationMs: ms } : {};
}
