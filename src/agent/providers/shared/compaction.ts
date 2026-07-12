/**
 * Provider-neutral history compaction — the orchestration, prompt, and pure
 * transcript algorithms shared by every provider that can summarize its own
 * message history.
 *
 * # Why this lives in shared/
 *
 * Compaction decomposes into three concerns that separate cleanly:
 *
 *   1. Orchestration — bail-checks, boundary selection, summarize, splice,
 *      emit. Provider-agnostic; lives here in {@link runCompactionCore}.
 *   2. Representation — how a provider's message type flattens to text, which
 *      messages are "fresh user turns", how the synthetic preamble is shaped.
 *      Provider-specific; supplied via {@link CompactionOps}.
 *   3. The model call — turning a transcript into a summary. Already exists as
 *      each provider's one-shot completion primitive (`oneshot.ts`); injected
 *      as the `summarize` closure so no bespoke per-provider summarizer method
 *      is needed.
 *
 * Previously all three lived inside `anthropic-direct/compact.ts`, which is why
 * compaction was Anthropic-only. Lifting concerns (1) and the generic form of
 * the (2) algorithms here — parameterized over a provider `CompactionOps<M>` —
 * lets any provider gain compaction by implementing a small ops object and
 * passing its existing one-shot as `summarize`. Mirrors the earlier lift of
 * threshold logic into `shared/auto-compact.ts`.
 *
 * Invariant: every provider's `findBoundary` must land the kept tail on a
 * fresh user turn so the synthetic `[user_summary, assistant_ack]` preamble can
 * be prepended without breaking user/assistant alternation, and must never
 * split a tool round (a `tool_use`/`tool_call` and its matching result must
 * travel together). The generic {@link findCompactionBoundary} enforces this by
 * counting only messages for which `ops.isFreshUserTurn` returns true.
 *
 * @module agent/providers/shared/compaction
 */

import type { ProviderCompactResult } from '../../provider.js';

/**
 * System instruction for the summarization call. Crafted to preserve what a
 * future turn actually needs: user intent and corrections, tool decisions and
 * outcomes, current state and next action, open questions, and key facts.
 *
 * Provider-neutral — the summarizer only ever sees a plain-text transcript, so
 * this prompt makes no assumption about the underlying message representation.
 */
export const COMPACT_SYSTEM_PROMPT = [
  'You are a conversation-summarization assistant. The user will paste a',
  'prior conversation between a user and an AI assistant that includes tool',
  'calls and tool results. Produce a concise but complete summary that lets',
  'the AI continue the conversation without losing track.',
  '',
  'Preserve, in this priority order:',
  "1. The user's original intent, explicit asks, constraints, corrections,",
  '   and preferences stated during the conversation.',
  '2. Tool decisions and their outcomes — file paths read or written, shell',
  '   commands run, search queries, URLs fetched, code edits made, tests',
  '   run, errors observed, and whether each action succeeded or failed.',
  '3. Current state: what has been completed, what remains unresolved, and',
  '   the safest next action.',
  '4. Open questions, pending decisions, blockers, and assumptions.',
  '5. Key facts the assistant discovered (function locations, schemas,',
  '   observed behaviors, important external findings).',
  '',
  'Drop prose narration, conversational filler, and exploratory dead-ends.',
  'Drop verbatim tool output unless an exact snippet, error, path, command,',
  'or result is needed for continuation.',
  'Do not invent details. If something is uncertain, mark it explicitly.',
  'Output plain text, no markdown headers. Aim for ~250 words; use up to',
  '~400 only when needed to preserve tool state or unresolved tasks.',
].join('\n');

/** Default header the summary message uses to flag itself in history. */
export const COMPACT_SUMMARY_HEADER = '[Compacted summary of earlier conversation]';

/** Default acknowledgement the synthetic assistant turn returns. */
export const COMPACT_ACK_TEXT = 'Acknowledged. Continuing from the summary above.';

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

/** Wall-clock ceiling for a single summarization call (guardrail). */
export const DEFAULT_COMPACT_TIMEOUT_MS = 60_000;

/**
 * Provider-specific message-representation primitives. Pure — no I/O, no SDK
 * client, no logging — so they unit-test without a network. Everything a
 * provider must supply to participate in compaction lives here; the generic
 * algorithms below are written against this interface.
 */
export interface CompactionOps<M> {
  /**
   * True when `msg` is a real user turn (not a tool-result follow-up the loop
   * synthesized). The boundary walk counts only these.
   */
  isFreshUserTurn(msg: M): boolean;
  /**
   * Render one message as a plain-text transcript block, including its speaker
   * label. Tool calls/results are flattened to compact markers; images and
   * other non-text blocks are elided to short placeholders. Multi-line output
   * is fine — {@link renderTranscript} joins blocks with blank lines.
   */
  renderMessage(msg: M): string;
  /**
   * Build the synthetic preamble spliced in front of the kept tail: a user
   * message carrying the summary and an assistant acknowledgement, in the
   * provider's own message shape.
   */
  buildPreamble(summaryText: string): [userSummary: M, assistantAck: M];
  /** Approximate character count of a message's content (for the saved-tokens estimate). */
  countChars(msg: M): number;
}

/**
 * Locate the index where the kept tail starts. Walk backwards counting fresh
 * user turns; the boundary is the index of the `keepLastN`-th fresh user turn
 * from the end.
 *
 * Returns:
 *   - `-1` when there are fewer than `keepLastN` fresh user turns (caller
 *     treats this as "history too short — no compaction").
 *   - An index `>= 0` otherwise. `messages.slice(boundary)` is the kept tail;
 *     `messages.slice(0, boundary)` is what gets summarized. `0` means the
 *     whole history is within the keep window (nothing older to summarize).
 */
export function findCompactionBoundary<M>(
  messages: ReadonlyArray<M>,
  keepLastN: number,
  ops: CompactionOps<M>,
): number {
  if (keepLastN <= 0) return messages.length;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && ops.isFreshUserTurn(msg)) {
      count += 1;
      if (count === keepLastN) return i;
    }
  }
  return -1;
}

/** Render a slice of messages as a plain-text transcript for the summarizer. */
export function renderTranscript<M>(
  messages: ReadonlyArray<M>,
  ops: CompactionOps<M>,
): string {
  const blocks: string[] = [];
  for (const msg of messages) blocks.push(ops.renderMessage(msg));
  return blocks.join('\n\n').trim();
}

/**
 * Splice in the synthetic preamble. Returns a new array; the caller decides
 * whether to assign it back to the provider's mutable history slot.
 */
export function applyCompaction<M>(
  messages: ReadonlyArray<M>,
  boundary: number,
  summaryText: string,
  ops: CompactionOps<M>,
): M[] {
  const [summary, ack] = ops.buildPreamble(summaryText);
  return [summary, ack, ...messages.slice(boundary)];
}

/**
 * Estimate input tokens saved by replacing `[0, boundary)` with the synthetic
 * preamble. Rough char/4 heuristic — good enough for a UX hint, not billing.
 */
export function estimateTokensSaved<M>(
  before: ReadonlyArray<M>,
  boundary: number,
  summaryText: string,
  ops: CompactionOps<M>,
): number {
  let droppedChars = 0;
  for (const msg of before.slice(0, boundary)) droppedChars += ops.countChars(msg);
  const addedChars = COMPACT_SUMMARY_HEADER.length + 2 + summaryText.length + COMPACT_ACK_TEXT.length;
  const delta = Math.max(0, droppedChars - addedChars);
  return Math.round(delta / 4);
}

/** Success payload handed to {@link CompactionCoreDeps.onSuccess} for witness emit. */
export interface CompactionSuccess<M> {
  /** Messages `[0, boundary)` that were summarized away (pre-splice). */
  olderSlice: M[];
  /** The generated summary text. */
  summary: string;
  /** Count of kept-tail messages (messagesBefore - boundary). */
  keptTailCount: number;
  /** The keepLastN config that produced this boundary. */
  keepLastN: number;
  messagesBefore: number;
  messagesAfter: number;
  tokensSavedEstimate: number;
}

/** Injected collaborators for {@link runCompactionCore}. */
export interface CompactionCoreDeps<M> {
  /** The provider's mutable running-history array. Mutated in place on success. */
  messages: M[];
  ops: CompactionOps<M>;
  keepLastN: number;
  /**
   * Turn a plain-text transcript into a summary. Backed by the provider's own
   * one-shot completion primitive. Rejection (rate limit, network, abort) is
   * caught by the core and reported as a typed no-op reason.
   */
  summarize(transcript: string): Promise<string>;
  /** True if the surrounding turn/abort scope was cancelled — reclassifies a failure as `aborted`. */
  isAborted(): boolean;
  /** Cancel the in-flight summarize request when the timeout guardrail fires. */
  abortInFlight?(): void;
  /** Guardrail ceiling for the summarize call. Defaults to {@link DEFAULT_COMPACT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Fired after a successful in-place splice, for witness-layer emit. */
  onSuccess?(info: CompactionSuccess<M>): void;
}

/**
 * Run the provider-agnostic core of one compaction pass: locate the boundary,
 * render + summarize the older slice, and splice the synthetic preamble in
 * place of it. Provider-specific pre-flight (session-closed / turn-in-flight
 * checks, abort-scope setup) stays in the caller; this owns the algorithm and
 * the safety guardrails.
 *
 * Guardrails (never corrupt live history on a bad summary):
 *   - the summarize call is bounded by `timeoutMs`; a timeout cancels the
 *     in-flight request (`abortInFlight`) and returns a typed no-op;
 *   - any rejection is caught and mapped to `aborted` (when `isAborted()`) or
 *     `summarization-failed: <msg>` — history is left untouched;
 *   - an empty/whitespace summary is refused (`empty-summary`) rather than
 *     spliced, so a flaky model can never blank out the conversation.
 *
 * Mutates `messages` in place ONLY on the success path. Every failure path
 * (too-short, nothing-to-summarize, aborted, timeout, failed, empty) leaves
 * `messages` byte-for-byte unchanged.
 */
export async function runCompactionCore<M>(
  deps: CompactionCoreDeps<M>,
): Promise<ProviderCompactResult> {
  const { messages, ops, keepLastN, summarize, isAborted } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
  const messagesBefore = messages.length;
  const unchanged = { messagesBefore, messagesAfter: messagesBefore } as const;

  const boundary = findCompactionBoundary(messages, keepLastN, ops);
  if (boundary < 0) {
    return { compacted: false, reason: 'history-too-short', ...unchanged };
  }
  if (boundary === 0) {
    // Kept tail starts at message 0 — the whole history is within the keep
    // window, so there is nothing older to summarize.
    return { compacted: false, reason: 'nothing-to-summarize', ...unchanged };
  }
  if (isAborted()) {
    return { compacted: false, reason: 'aborted', ...unchanged };
  }

  const olderSlice = messages.slice(0, boundary);
  const transcript = renderTranscript(olderSlice, ops);

  let summary: string;
  try {
    summary = await withTimeout(summarize(transcript), timeoutMs, deps.abortInFlight);
  } catch (err) {
    if (isAborted()) {
      return { compacted: false, reason: 'aborted', ...unchanged };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { compacted: false, reason: 'summarization-failed: ' + msg, ...unchanged };
  }

  if (summary.trim().length === 0) {
    return { compacted: false, reason: 'empty-summary', ...unchanged };
  }

  const tokensSavedEstimate = estimateTokensSaved(messages, boundary, summary, ops);
  const newMessages = applyCompaction(messages, boundary, summary, ops);
  // Splice in place so the provider's history reference stays stable.
  messages.splice(0, messages.length, ...newMessages);
  const messagesAfter = messages.length;

  deps.onSuccess?.({
    olderSlice,
    summary,
    keptTailCount: messagesBefore - boundary,
    keepLastN,
    messagesBefore,
    messagesAfter,
    tokensSavedEstimate,
  });

  return { compacted: true, messagesBefore, messagesAfter, tokensSavedEstimate };
}

/** Timeout sentinel distinct from any provider/SDK error. */
class CompactionTimeoutError extends Error {
  constructor(ms: number) {
    super(`summarization timed out after ${ms}ms`);
    this.name = 'CompactionTimeoutError';
  }
}

/**
 * Race a promise against a timeout. On timeout, invoke `onTimeout` (to cancel
 * the in-flight request) and reject with {@link CompactionTimeoutError}. The
 * timer is always cleared so the event loop is not held open.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new CompactionTimeoutError(ms));
      }
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
