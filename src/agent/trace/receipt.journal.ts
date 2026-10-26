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

import type { JournalMessage } from '../journal/types.js';

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

/**
 * Extract a {@link JournalSummary} from a folded journal message array.
 * Pure — no I/O. Returns `undefined` when the journal is absent.
 */
export function extractJournalSummary(
  messages: JournalMessage[] | null,
  textDisabled: boolean,
): JournalSummary | undefined {
  if (messages === null || messages.length === 0) return undefined;

  const firstUser = messages.find((m) => m.role === 'user');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  const extractText = (msg: JournalMessage | undefined): string | undefined => {
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
  };

  const toolNamesSeen = new Set<string>();
  let toolUseCount = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        toolUseCount++;
        toolNamesSeen.add(b.name);
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
