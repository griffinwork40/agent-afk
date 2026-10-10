/**
 * Convert a folded journal message array into the Turn[] / ToolEvent[] shape
 * consumed by the outcome labeling functions.
 *
 * This is ONLY the converter — no I/O. The loader in load-outcome-turns.ts
 * is responsible for reading the journal and calling this.
 *
 * Dependency direction: outcomes → journal (never the reverse).
 *
 * ## Turn boundary rule
 * A new Turn starts on every assistant message, and on every user message
 * that carries NO tool_result block (a real prompt). A user message that
 * carries any tool_result is tool-result delivery for the preceding assistant
 * turn, never a new turn, even when the harness appended text to it (hook
 * nudges, framework context, queued messages): that text is not a typed
 * prompt and must not reach in_session_correction's keyword match. Turn
 * granularity only matters for in_session_correction (turns[1..].user) and
 * extractFirstPrompt; every other LF flattens toolEvents or scans all
 * assistant texts, so splitting per assistant message is label-neutral.
 *
 * ## Tool input
 * `ToolEvent.input` is built with the SAME summarizeToolInput the providers
 * use when they emit the tool-use event that ends up in the sidecar, so a
 * journal-derived input is byte-identical to a sidecar-derived one.
 *
 * ## isError mapping
 * The journal writer records `isError` ONLY when true (verified in
 * journal-adapter.ts:96: `...(block.is_error !== undefined ? { isError:
 * block.is_error } : {})`). In 40 real journals: 94 `"isError":true` entries
 * and zero `"isError":false`. Therefore: `isError = block.isError === true`
 * — omitted becomes false, never undefined, matching the sidecar contract
 * where an explicit boolean is always stored.
 *
 * ## Preamble stripping
 * The journal's first user message may contain injected preamble context
 * (bridge context, memory hints, skill dispatch tags) that the sidecar never
 * persists as `turn.user`. We use the existing `extractUserContent` /
 * `isPreamble` helpers to strip the preamble and surface only the real user
 * prompt so `extractFirstPrompt` and cross_session_reask Jaccard matching
 * are not polluted.
 *
 * ## resultTail
 * For verification commands, we reuse RESULT_TAIL_CHARS (exported from
 * verification-patterns.ts) and redactSecrets (from redact-secrets.ts) so
 * journal-derived tails match sidecar-derived ones exactly.
 *
 * ## Spilled / blob content
 * Journal content parts may be `text_ref` when a large result was spilled to
 * the blob store. We call hydrateMessages before converting so refs resolve
 * to inline text; if hydration fails the hydrate layer gracefully substitutes
 * a "[journal: spilled text … is missing]" stand-in, which is fine for the
 * LFs (they regex-search text, never need raw bytes).
 *
 * @module agent/outcomes/journal-turns
 */


import { extractUserContent } from '../session/preamble-strip.js';
import { summarizeToolInput } from '../providers/shared/tool-input-summary.js';
import type { JournalMessage, JournalBlock, JournalResultPart } from '../journal/types.js';
import type { Turn, ToolEvent } from './artifacts.js';
import { buildVerificationResultTail } from './verification-patterns.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Concatenate all text blocks from a message's content into one string. */
function textOf(blocks: JournalBlock[]): string {
  return blocks
    .flatMap((b) => {
      if (b.type === 'text') return [b.text];
      // text_ref preview (should already be hydrated, but defensive fallback)
      if (b.type === 'text_ref') return [b.preview];
      return [];
    })
    .join('');
}

/** Flatten a tool_result's content parts to one string. */
function resultTextOf(parts: JournalResultPart[]): string {
  return parts
    .flatMap((p) => {
      if (p.type === 'text') return [p.text];
      if (p.type === 'text_ref') return [p.preview];
      return [];
    })
    .join('');
}

/** True when a user message carries at least one tool_result block. */
function carriesToolResult(msg: JournalMessage): boolean {
  return msg.content.some((b) => b.type === 'tool_result');
}

/**
 * Attach every tool_result in `msg` to its pending ToolEvent (matched by
 * toolUseId). Unmatched results are ignored; matched events leave the map.
 */
function attachToolResults(msg: JournalMessage, pending: Map<string, ToolEvent>): void {
  for (const block of msg.content) {
    if (block.type !== 'tool_result') continue;
    const ev = pending.get(block.toolUseId);
    if (!ev) continue;
    pending.delete(block.toolUseId);

    const resultText = resultTextOf(block.content);
    ev.result = resultText;
    // isError: the journal writer records isError ONLY when true (see module
    // comment), so absence means success and the mapping is a definite boolean.
    ev.isError = block.isError === true;
    const rt = buildVerificationResultTail(ev.toolName, ev.input ?? '', resultText);
    if (rt !== undefined) ev.resultTail = rt;
  }
}

/** Build the Turn for one assistant message, registering its tool_use blocks. */
function assistantTurn(msg: JournalMessage, pending: Map<string, ToolEvent>): Turn {
  const turn: Turn = {};
  const assistantText = textOf(msg.content);
  if (assistantText) turn.assistant = assistantText;
  for (const block of msg.content) {
    if (block.type !== 'tool_use') continue;
    const inputSummary = summarizeToolInput(block.name, block.input);
    const ev: ToolEvent = {
      toolName: block.name,
      ...(inputSummary ? { input: inputSummary } : {}),
    };
    pending.set(block.id, ev);
    (turn.toolEvents ??= []).push(ev);
  }
  return turn;
}

// ---------------------------------------------------------------------------
// Public converter
// ---------------------------------------------------------------------------

/**
 * Convert an already-hydrated journal message array into Turn[].
 *
 * Call `hydrateMessages()` on the fold result BEFORE passing here so that
 * spilled text_ref parts are resolved to inline text (or stand-in text when
 * a blob is missing). This function performs NO I/O.
 */
export function journalMessagesToTurns(messages: JournalMessage[]): Turn[] {
  const turns: Turn[] = [];
  // toolUseId -> ToolEvent awaiting its tool_result in a later user message.
  const pending = new Map<string, ToolEvent>();

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      turns.push(assistantTurn(msg, pending));
      continue;
    }
    if (carriesToolResult(msg)) {
      // Tool-result delivery: attach, never start a turn (see module doc).
      attachToolResults(msg, pending);
      continue;
    }
    // Real user prompt. Only the first one carries the harness preamble
    // (bridge context, memory hints, skill tags) that the sidecar never
    // persists; extractUserContent returns undefined when it finds no
    // preamble structure, in which case the raw text is kept.
    const rawText = textOf(msg.content);
    const isFirstUserTurn = !turns.some((t) => t.user !== undefined);
    const userText = isFirstUserTurn ? (extractUserContent(rawText) ?? rawText) : rawText;
    turns.push(userText ? { user: userText } : {});
  }

  return turns;
}
