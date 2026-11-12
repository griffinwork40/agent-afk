/**
 * Journal enrichment for run receipts (v2).
 *
 * Extracted from `receipt.ts` to keep that file within the 350-code-line
 * ceiling. Owns the {@link JournalSummary} type and the pure
 * {@link extractJournalSummary} extractor. No I/O — the journal read
 * stays in `writeRunReceipt`.
 *
 * @module agent/trace/receipt.journal
 */

import type { JournalMessage, JournalRecord } from '../journal/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Journal-derived content summary added in receipt v2. */
export interface JournalSummary {
  /** Text of the first user message (truncated to 500 chars). */
  firstUserMessage?: string;
  /** Text of the last assistant message (truncated to 500 chars). */
  lastAssistantMessage?: string;
  /** Tool names in call order (deduplicated). */
  toolNames: string[];
  /** Total count of tool_use blocks in the journal. */
  toolUseCount: number;
  /** Total message count in the folded journal. */
  messageCount: number;
  /** True when AFK_RUN_RECEIPT_TEXT_DISABLED=1 suppressed text fields. */
  textRedacted?: boolean;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const JOURNAL_TEXT_CAP = 500;

function extractText(msg: JournalMessage | undefined): string | undefined {
  if (msg === undefined) return undefined;
  const parts: string[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'text_ref') parts.push(b.preview);
  }
  const joined = parts.join('');
  if (joined.length === 0) return undefined;
  return joined.length > JOURNAL_TEXT_CAP
    ? joined.slice(0, JOURNAL_TEXT_CAP) + '\u2026'
    : joined;
}

/**
 * Scan raw journal records for the original first user message and the full
 * tool call history. Raw records include pre-compaction `append` entries that
 * `foldJournal` discards after a `truncate(k, 'compact')` record, so this
 * survives mid-session compaction where the folded view would otherwise return
 * a synthetic compaction summary as `firstUserMessage`.
 *
 * Strategy: collect every `append` record whose `message.role === 'user'`,
 * then pick the one with the lowest `index` value as the original message.
 * Similarly, collect tool_use blocks from ALL `append` records regardless of
 * whether compaction removed those messages from the live fold.
 */
function extractFromRawRecords(records: readonly JournalRecord[]): {
  firstUser: JournalMessage | undefined;
  toolNamesSeen: Set<string>;
  toolUseCount: number;
} {
  let firstUser: JournalMessage | undefined;
  let firstUserIndex = Infinity;
  const toolNamesSeen = new Set<string>();
  let toolUseCount = 0;

  for (const rec of records) {
    if (rec.kind !== 'append') continue;
    const { index, message } = rec;
    if (message.role === 'user' && index < firstUserIndex) {
      firstUser = message;
      firstUserIndex = index;
    }
    for (const b of message.content) {
      if (b.type === 'tool_use') {
        toolUseCount++;
        toolNamesSeen.add(b.name);
      }
    }
  }

  return { firstUser, toolNamesSeen, toolUseCount };
}

/**
 * Extract a {@link JournalSummary} from a folded journal message array.
 *
 * When `rawRecords` are provided (the pre-fold journal records), they are used
 * to derive `firstUserMessage` and `toolNames`/`toolUseCount` — surviving
 * mid-session compaction where the folded view replaces the original
 * conversation prefix with a synthetic summary. The folded `messages` array is
 * still used for `lastAssistantMessage` and `messageCount` (the folded count
 * reflects the live context window, which is the meaningful value there).
 *
 * Pure — no I/O. Returns `undefined` when the journal is absent.
 */
export function extractJournalSummary(
  messages: JournalMessage[] | null,
  textDisabled: boolean,
  rawRecords?: readonly JournalRecord[],
): JournalSummary | undefined {
  if (messages === null || messages.length === 0) return undefined;

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  let firstUser: JournalMessage | undefined;
  let toolNamesSeen: Set<string>;
  let toolUseCount: number;

  if (rawRecords !== undefined && rawRecords.length > 0) {
    // Use raw records to survive compaction: the folded view's first 'user'
    // message may be a synthetic compaction summary after mid-session compaction.
    const raw = extractFromRawRecords(rawRecords);
    firstUser = raw.firstUser;
    toolNamesSeen = raw.toolNamesSeen;
    toolUseCount = raw.toolUseCount;
  } else {
    // Fallback: no raw records available — use the folded view as before.
    firstUser = messages.find((m) => m.role === 'user');
    toolNamesSeen = new Set<string>();
    toolUseCount = 0;
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          toolUseCount++;
          toolNamesSeen.add(b.name);
        }
      }
    }
  }

  return {
    ...(!textDisabled && extractText(firstUser) !== undefined
      ? { firstUserMessage: extractText(firstUser)! }
      : {}),
    ...(!textDisabled && extractText(lastAssistant) !== undefined
      ? { lastAssistantMessage: extractText(lastAssistant)! }
      : {}),
    toolNames: [...toolNamesSeen],
    toolUseCount,
    messageCount: messages.length,
    ...(textDisabled ? { textRedacted: true } : {}),
  };
}
