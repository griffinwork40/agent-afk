/**
 * What the compaction summarizer sees and how much it may write: the system
 * prompt, the transcript wrapper, the shared output budget, head-and-tail tool
 * excerpts, and the total transcript cap. Extracted from `compaction.ts` (350
 * code-line ceiling) as one whole concern; `compaction.ts` re-exports the
 * prompt and wrapper so existing importers resolve unchanged.
 *
 * @module agent/providers/shared/compaction.summarizer-input
 */

import { contextLimitFor } from '../../model-limits.js';

/**
 * Contract: structured, provider-neutral plain-text instruction for the
 * summarization call. The labelled sections are fixed so a later turn can find
 * goal, decisions, files, and next step in the same place every time. The
 * summarizer only ever sees a plain-text transcript, so this prompt makes no
 * assumption about the underlying message representation.
 */
export const COMPACT_SYSTEM_PROMPT = [
  'You are a conversation-summarization assistant. The user will paste a',
  'prior conversation between a user and an AI assistant that includes tool',
  'calls and tool results. Produce a summary that lets the AI continue the',
  'work without losing track.',
  '',
  'Organise the summary under exactly these plain-text labels, in this order.',
  'Write "none" under a label that has nothing to report.',
  '',
  "GOAL AND CONSTRAINTS: the user's intent, explicit asks, constraints,",
  '  corrections, and stated preferences.',
  'PROGRESS: what has been completed so far.',
  'DECISIONS: decisions made and why, plus approaches tried and rejected.',
  'FILES AND COMMANDS: files read or written, commands run, searches, and',
  '  URLs fetched, each with its outcome (succeeded, failed, error text).',
  'CURRENT STATE AND NEXT STEP: where the work stands and the safest next',
  '  action.',
  'OPEN QUESTIONS: unresolved questions, pending decisions, blockers, and',
  '  assumptions.',
  '',
  'Prefer exact file paths, commands, identifiers, and error text over',
  'narration. Drop conversational filler. Tool output in the transcript may',
  'be excerpted; an elision marker shows where text was cut.',
  'Do not invent details. If something is uncertain, mark it explicitly.',
  'Output plain text with no markdown. Be complete but stay within your',
  'output budget; finish every section rather than stopping mid-sentence.',
].join('\n');

/**
 * Wrap a rendered transcript in the single user instruction the summarizer
 * sees. Shared by every provider so the summarization prompt stays identical
 * regardless of which model/endpoint produces the summary.
 */
export function wrapTranscriptForSummary(transcript: string): string {
  return (
    'Summarize the following conversation transcript. Follow the ' +
    'system instructions exactly.\n\n' +
    '<transcript>\n' +
    transcript +
    '\n</transcript>'
  );
}

/**
 * Output-token budget for every summarizer path (Anthropic same-family,
 * OpenAI-compatible chat and responses wires, and the cross-provider one-shot).
 * Sized for the six-section structured summary; kept at 2,000 so a cheap
 * summarizer model stays fast.
 */
export const COMPACT_SUMMARY_MAX_TOKENS = 2_000;

/** Character budget for one tool call's arguments in the transcript. */
export const TOOL_ARGS_EXCERPT_CHARS = 600;

/** Character budget for one tool result's content in the transcript. */
export const TOOL_RESULT_EXCERPT_CHARS = 1_500;

/** Share of an excerpt budget given to the head; the rest goes to the tail. */
const EXCERPT_HEAD_SHARE = 0.4;

/**
 * Excerpt `text` to about `maxChars` by keeping a head and a tail with an
 * explicit elision marker between them. Errors and final results usually sit
 * at the END of tool output, so the tail gets the larger share. Text at or
 * under `maxChars` is returned unchanged. The marker itself is not counted
 * against `maxChars`.
 */
export function excerptHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * EXCERPT_HEAD_SHARE);
  const tailLen = Math.max(0, maxChars - headLen);
  const headEnd = pairSafeHeadEnd(text, headLen);
  const tailStart = pairSafeTailStart(text, text.length - tailLen);
  const elided = tailStart - headEnd;
  return `${text.slice(0, headEnd)} [... ${elided} chars elided ...] ${text.slice(tailStart)}`;
}

/** True when `code` is a UTF-16 high (leading) surrogate. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** True when `code` is a UTF-16 low (trailing) surrogate. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Contract: end index for a kept head `text.slice(0, end)` that never splits a
 * surrogate pair. When the cut falls inside a pair it backs off one unit, so
 * less text is kept, never more. Other cuts are returned unchanged.
 */
function pairSafeHeadEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)) ? end - 1 : end;
}

/**
 * Contract: start index for a kept tail `text.slice(start)` that never splits a
 * surrogate pair. When the cut falls inside a pair it moves forward one unit,
 * so less text is kept, never more. Other cuts are returned unchanged.
 */
function pairSafeTailStart(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  return isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1)) ? start + 1 : start;
}

/** Fraction of the summarizer model's context window the transcript may use. */
const SUMMARIZER_INPUT_WINDOW_SHARE = 0.5;

/**
 * Conservative characters-per-token ratio for converting the token budget to
 * characters. Code and JSON tokenize denser than prose, so 3 (not 4) keeps the
 * capped transcript inside the share above on tool-heavy sessions.
 */
const CHARS_PER_TOKEN = 3;

/**
 * Character cap for the rendered transcript, derived from the context window of
 * the model that will actually write the summary (about half its window).
 * `model` must be the RESOLVED summarizer model, not the session model, since
 * `AFK_COMPACT_MODEL` can route to a smaller-window model or another provider.
 */
export function summarizerInputCharBudget(model: string, subscriptionPath = false): number {
  const window = contextLimitFor(model, subscriptionPath);
  return Math.max(1, Math.floor(window * SUMMARIZER_INPUT_WINDOW_SHARE * CHARS_PER_TOKEN));
}

/** Share of the transcript cap reserved for the opening of the transcript. */
const CAP_OPENING_SHARE = 0.2;

/**
 * Bound the transcript string sent to the summarizer. Under the cap it is
 * returned unchanged. Over the cap the MIDDLE is dropped: the opening is kept
 * because it holds the user's original request and, on a repeat compaction,
 * the previous compacted summary (message 0), and the newest text is kept
 * because it holds the current state. A marker states what was omitted. Only
 * affects the summarizer input; the archived older slice is untouched.
 */
export function capTranscriptForSummarizer(transcript: string, maxChars: number | undefined): string {
  if (maxChars === undefined || transcript.length <= maxChars) return transcript;
  const openingLen = Math.floor(maxChars * CAP_OPENING_SHARE);
  const newestLen = maxChars - openingLen;
  const openingEnd = pairSafeHeadEnd(transcript, openingLen);
  const newestStart = pairSafeTailStart(transcript, transcript.length - newestLen);
  const dropped = newestStart - openingEnd;
  return (
    transcript.slice(0, openingEnd) +
    `\n\n[Transcript middle omitted: ${dropped} characters dropped to fit the ` +
    'summarizer context budget. The opening above and the newest content below are kept.]\n\n' +
    transcript.slice(newestStart)
  );
}
