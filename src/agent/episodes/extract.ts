/**
 * Episode input extraction from a sealed session journal.
 *
 * Reads the journal with a strict token budget (~8K tokens) to produce
 * EpisodeInput for synthesis. Thinking blocks and full tool inputs/outputs
 * are excluded — only structural signals are carried.
 *
 * Design invariants:
 *   - Never throws: returns a minimal stub on any error.
 *   - Excludes thinking blocks entirely (largest token contributor).
 *   - Excludes full tool inputs/outputs (names only).
 *   - Excludes blob content (referenced by path, never hydrated).
 *   - CHAR_BUDGET limits total text extracted (~32K chars ≈ 8K tokens).
 *
 * @module agent/episodes/extract
 */

import { readJournalRecords, foldJournal } from '../journal/reader.js';
import { getOrDeriveFacet } from '../facets/store.js';
import type { JournalBlock, JournalMarkLabel, JournalMessage } from '../journal/types.js';
import type { EpisodeInput } from './types.js';

// ~32K chars ≈ 8K tokens at ~4 chars/token
const CHAR_BUDGET = 32_000;
const FIRST_MSG_CAP = 2_000;
const LAST_MSG_CAP = 4_000;
const TOOL_NAME_CAP = 200; // max unique tool names to record
const ERROR_FIRST_LINE_CAP = 200; // chars per error

// Mark labels that signal session shape changes
const SHAPE_MARKS = new Set<JournalMarkLabel>(['compact', 'rewind', 'clear', 'resume', 'model_switch']);

// ---------------------------------------------------------------------------
// Block text extraction (no thinking, no blob content)
// ---------------------------------------------------------------------------

function extractTextFromBlock(block: JournalBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'text_ref':
      // Blob spill — use the preview only (never hydrate)
      return block.preview;
    case 'thinking':
    case 'redacted_thinking':
      // Excluded by design — largest token contributor
      return '';
    case 'tool_use':
      // Name only — not the full input
      return '';
    case 'tool_result':
      return '';
    default:
      return '';
  }
}

function messageText(msg: JournalMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    const t = extractTextFromBlock(block);
    if (t) parts.push(t);
  }
  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Tool signal extraction
// ---------------------------------------------------------------------------

function extractToolSignals(messages: JournalMessage[]): {
  toolsUsed: string[];
  toolErrors: string[];
} {
  const seen = new Set<string>();
  const toolsUsed: string[] = [];
  const toolErrors: string[] = [];

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        if (!seen.has(block.name) && toolsUsed.length < TOOL_NAME_CAP) {
          seen.add(block.name);
          toolsUsed.push(block.name);
        }
      } else if (block.type === 'tool_result' && block.isError === true) {
        // Collect tool name via toolUseId lookup — we just record what we can
        // from the content itself (first line of first text part)
        const content = block.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part) {
              const firstLine = String(part.text).split('\n')[0]?.slice(0, ERROR_FIRST_LINE_CAP) ?? '';
              if (firstLine) {
                toolErrors.push(firstLine);
                break;
              }
            }
          }
        }
      }
    }
  }

  return { toolsUsed, toolErrors };
}

// ---------------------------------------------------------------------------
// Mark sequence extraction
// ---------------------------------------------------------------------------

function extractMarkSequence(records: ReturnType<typeof readJournalRecords>): string[] {
  const marks: string[] = [];
  for (const rec of records) {
    if (rec.kind === 'mark' && SHAPE_MARKS.has(rec.label)) {
      marks.push(rec.label);
    }
  }
  return marks;
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Extract episode input from a sealed session journal.
 * Never throws — returns a minimal stub on any error.
 */
export function extractEpisodeInput(sessionId: string): EpisodeInput {
  const stub: EpisodeInput = {
    sessionId,
    firstUserMessage: '',
    markSequence: [],
    toolsUsed: [],
    toolErrors: [],
    lastAssistantMessage: '',
  };

  try {
    const records = readJournalRecords(sessionId);
    if (records.length === 0) return stub;

    const markSequence = extractMarkSequence(records);
    const fold = foldJournal(records);
    const messages = fold.messages;

    if (messages.length === 0) return { ...stub, markSequence };

    // First user message
    let firstUserMessage = '';
    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = messageText(msg);
        if (text) {
          firstUserMessage = text.slice(0, FIRST_MSG_CAP);
          break;
        }
      }
    }

    // Last assistant message
    let lastAssistantMessage = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role === 'assistant') {
        const text = messageText(msg);
        if (text) {
          lastAssistantMessage = text.slice(0, LAST_MSG_CAP);
          break;
        }
      }
    }

    // Tool signals
    const { toolsUsed, toolErrors } = extractToolSignals(messages);

    // Budget check: cap total char contribution
    const totalChars =
      firstUserMessage.length + lastAssistantMessage.length +
      toolsUsed.join('').length + toolErrors.join('').length;
    const overBudget = totalChars > CHAR_BUDGET;
    if (overBudget) {
      // Trim last assistant message to fit
      const remaining = CHAR_BUDGET - firstUserMessage.length - toolsUsed.join('').length - toolErrors.join('').length;
      lastAssistantMessage = lastAssistantMessage.slice(0, Math.max(500, remaining));
    }

    // Facet metadata (best-effort)
    let facetSummary: string | undefined;
    let costUsd: number | undefined;
    try {
      const facet = getOrDeriveFacet(sessionId);
      if (facet) {
        const parts: string[] = [];
        if (facet.outcome) parts.push(`outcome: ${facet.outcome}`);
        const rawCost = facet['cost_usd'];
        if (typeof rawCost === 'number') {
          costUsd = rawCost;
          parts.push(`cost: $${rawCost.toFixed(4)}`);
        }
        if (parts.length > 0) facetSummary = parts.join(', ');
      }
    } catch {
      // facet is optional — swallow
    }

    return {
      sessionId,
      firstUserMessage,
      markSequence,
      toolsUsed,
      toolErrors,
      lastAssistantMessage,
      ...(facetSummary !== undefined ? { facetSummary } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  } catch {
    return stub;
  }
}
