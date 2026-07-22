/**
 * OpenAI-compatible history compaction: the `CompactionOps<OpenAIMessage>`
 * implementation plus a thin handler that routes through the provider-neutral
 * {@link runCompactionCore}.
 *
 * This is the OpenAI counterpart to `anthropic-direct/compact.ts`. All the
 * orchestration, guardrails, prompt, and generic algorithms live in
 * `shared/compaction.ts`; this file supplies only the OpenAI message
 * representation and wires the session's own one-shot completion as the
 * summarizer.
 *
 * # Boundary invariant (OpenAI tool-round shape)
 *
 * OpenAI stores a tool round as `assistant{ tool_calls[] }` followed by one or
 * more `role:'tool'` result messages (each carrying a `tool_call_id` that MUST
 * match an id on the preceding assistant turn, or the API rejects the next
 * request with HTTP 400 — see `query/dispatch-append.ts`). A "fresh user turn"
 * is therefore simply `role:'user'` — tool results are `role:'tool'`, distinct.
 * Landing the kept tail on a `role:'user'` message guarantees the tail never
 * *starts* with an orphaned `role:'tool'` (its assistant turn would have been
 * summarized away), so the 400 is structurally impossible. A vision
 * image-followup (a synthetic `role:'user'` pushed after tool results) can make
 * a boundary mildly suboptimal but never invalid.
 *
 * @module agent/providers/openai-compatible/compact
 */
import { env } from '../../../config/env.js';
import type { ProviderCompactResult } from '../../provider.js';
import { emitCompaction } from '../../trace/emit.js';
import type { TraceWriter } from '../../trace/index.js';
import type { CompactionTrigger } from '../../trace/types.js';
import {
  COMPACT_ACK_TEXT,
  COMPACT_SUMMARY_HEADER,
  DEFAULT_COMPACT_SHRINK_THRESHOLD,
  byteLengthOf,
  isMicrocompactPlaceholder,
  microcompactToolResults as sharedMicrocompactToolResults,
  resolveMicrocompactOptions,
  runCompactionCore,
  type CompactionOps,
  type MicrocompactOps,
  type MicrocompactOptions,
  type MicrocompactResult,
  type ToolResultRef,
} from '../shared/compaction.js';
import type { OpenAIMessage } from './messages.js';

const DEFAULT_COMPACT_KEEP_LAST_TURNS = 2;

/** Minimal structural view of an assistant `tool_calls[]` entry (runtime-present). */
interface OpenAIToolCallView {
  function?: { name?: string; arguments?: string };
}

/** Read the `tool_calls` array off a message without importing the OpenAI SDK type. */
function toolCallsOf(msg: OpenAIMessage): OpenAIToolCallView[] | undefined {
  const tc = (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(tc) ? (tc as OpenAIToolCallView[]) : undefined;
}

function truncateArgs(args: string): string {
  return args.length > 240 ? args.slice(0, 237) + '...' : args;
}

/** True for real user input. Tool results are `role:'tool'`, not `'user'`. */
export function isFreshUserTurn(msg: OpenAIMessage): boolean {
  return msg.role === 'user';
}

/** Render one OpenAI message as a transcript block (speaker + flattened content). */
function renderMessage(msg: OpenAIMessage): string {
  const speaker =
    msg.role === 'user'
      ? 'User'
      : msg.role === 'assistant'
        ? 'Assistant'
        : msg.role === 'tool'
          ? 'Tool result'
          : 'System';
  const lines: string[] = [speaker + ':'];

  if (typeof msg.content === 'string') {
    if (msg.content.length > 0) lines.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') lines.push(part.text);
      else if (part.type === 'image_url') lines.push('[image]');
    }
  }

  const toolCalls = toolCallsOf(msg);
  if (toolCalls) {
    for (const tc of toolCalls) {
      const name = tc.function?.name ?? 'unknown';
      const args = truncateArgs(tc.function?.arguments ?? '');
      lines.push(`[tool call: ${name} ${args}]`);
    }
  }
  return lines.join('\n');
}

/** Approximate content-character count for one message (saved-tokens estimate). */
function countChars(msg: OpenAIMessage): number {
  let total = 0;
  if (typeof msg.content === 'string') {
    total += msg.content.length;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') total += part.text.length;
    }
  }
  const toolCalls = toolCallsOf(msg);
  if (toolCalls) {
    for (const tc of toolCalls) {
      total += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0);
    }
  }
  return total;
}

/**
 * Byte length of an OpenAI `role:'tool'` message's content: a string is measured
 * directly; a content-part array sums its `text` parts (image parts ignored —
 * they are not the byte hogs and clearing them is out of scope).
 */
function toolMessageContentBytes(content: OpenAIMessage['content']): number {
  if (typeof content === 'string') return byteLengthOf(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (part.type === 'text') total += byteLengthOf(part.text);
    }
    return total;
  }
  return 0;
}

/** True when a tool message's content already carries the placeholder sentinel. */
function isToolMessagePlaceholder(content: OpenAIMessage['content']): boolean {
  if (typeof content === 'string') return isMicrocompactPlaceholder(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') return isMicrocompactPlaceholder(part.text);
    }
  }
  return false;
}

/**
 * OpenAI microcompaction primitives. Each `role:'tool'` message is one tool
 * result; `clear()` swaps its `content` for a plain-string placeholder in place,
 * preserving the message and its `tool_call_id` so the assistant `tool_calls` →
 * `role:'tool'` pairing the API enforces (HTTP 400 otherwise) is never disturbed.
 */
export const openaiMicrocompactOps: MicrocompactOps<OpenAIMessage> = {
  listToolResults(messages: ReadonlyArray<OpenAIMessage>): ToolResultRef[] {
    const refs: ToolResultRef[] = [];
    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      refs.push({
        byteLength: toolMessageContentBytes(msg.content),
        isPlaceholder: isToolMessagePlaceholder(msg.content),
        clear(placeholder: string): void {
          // Only the content payload changes; role:'tool' and tool_call_id stay.
          msg.content = placeholder;
        },
      });
    }
    return refs;
  },
};

/**
 * Deterministic tool-result microcompaction for OpenAI history. Thin adapter
 * over the shared {@link sharedMicrocompactToolResults} bound to
 * {@link openaiMicrocompactOps}. Mutates `messages` in place; returns the
 * reclaimed block/byte counts. See shared docs for algorithm + invariants.
 */
export function microcompactToolResults(
  messages: ReadonlyArray<OpenAIMessage>,
  opts?: MicrocompactOptions,
): MicrocompactResult {
  return sharedMicrocompactToolResults(messages, openaiMicrocompactOps, opts ?? {});
}

/** OpenAI message-representation primitives for the shared compaction core. */
export const openaiCompactionOps: CompactionOps<OpenAIMessage> = {
  isFreshUserTurn,
  renderMessage,
  buildPreamble(summaryText: string): [OpenAIMessage, OpenAIMessage] {
    return [
      { role: 'user', content: COMPACT_SUMMARY_HEADER + '\n\n' + summaryText },
      { role: 'assistant', content: COMPACT_ACK_TEXT },
    ];
  },
  countChars,
};

/** How many trailing fresh user turns to keep uncompacted. */
export function readKeepLastN(): number {
  const raw = env.AFK_COMPACT_KEEP_LAST_TURNS;
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_COMPACT_KEEP_LAST_TURNS;
}

/**
 * Fullness fraction at/above which the keep-window may shrink so a
 * short-but-full session can still be compacted. `AFK_COMPACT_SHRINK_FRACTION`
 * overrides it; values outside (0, 1) exclusive fall back to the default.
 */
export function readShrinkFraction(): number {
  const raw = env.AFK_COMPACT_SHRINK_FRACTION;
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0 && n < 1) return n;
  }
  return DEFAULT_COMPACT_SHRINK_THRESHOLD;
}

/** Injected collaborators for {@link compactOpenAIHistory}. */
export interface CompactOpenAIHistoryDeps {
  /** The query's mutable running history — mutated in place on success. */
  priorTurns: OpenAIMessage[];
  /**
   * Turn a rendered transcript into a summary using the session's own client.
   * Receives the abort signal for the compaction scope so an `interrupt()`
   * cancels the summarization request cleanly.
   */
  summarize: (transcript: string, signal: AbortSignal) => Promise<string>;
  /** Session is closed — no compaction. */
  isClosed: boolean;
  /** No turn currently in flight (abort slot free). */
  isIdle: boolean;
  /** Open a fresh abort scope for the summarization request. */
  beginAbort: () => AbortController;
  /** Release the abort scope once the summarization settles. */
  clearAbort: (controller: AbortController) => void;
  /**
   * What initiated this compaction, for the witness trace. `'manual'` (REPL
   * /compact, Telegram, router) or `'token_threshold'` (the turn-boundary
   * auto-compaction trigger). Defaults to `'manual'`.
   */
  trigger?: CompactionTrigger;
  traceWriter?: TraceWriter;
  /**
   * Context-window fullness fraction (0–1) at compaction time. Enables the
   * adaptive keep-window so a short-but-full session can still be compacted.
   * See `shared/compaction.ts:findCompactionBoundaryAdaptive`. Defaults to `0`
   * (unknown → no shrink) when omitted.
   */
  usedFraction?: number;
  /** Fullness fraction at/above which the keep-window may shrink. */
  shrinkAtFraction?: number;
}

/**
 * Run one compaction pass over an OpenAI session's history. Mirrors
 * `anthropic-direct/query/compact-handler.ts`: bail with a typed reason when
 * closed or a turn is in flight, otherwise open an abort scope and delegate the
 * boundary → summarize → splice sequence (with guardrails) to
 * {@link runCompactionCore}. Mutates `priorTurns` in place only on success.
 */
export async function compactOpenAIHistory(
  deps: CompactOpenAIHistoryDeps,
): Promise<ProviderCompactResult> {
  const messagesBefore = deps.priorTurns.length;
  if (deps.isClosed) {
    return { compacted: false, reason: 'session-closed', messagesBefore, messagesAfter: messagesBefore };
  }
  if (!deps.isIdle) {
    return { compacted: false, reason: 'turn-in-flight', messagesBefore, messagesAfter: messagesBefore };
  }

  const controller = deps.beginAbort();
  let result: ProviderCompactResult;
  try {
    result = await runCompactionCore<OpenAIMessage>({
      messages: deps.priorTurns,
      ops: openaiCompactionOps,
      keepLastN: readKeepLastN(),
      usedFraction: deps.usedFraction,
      shrinkAtFraction: deps.shrinkAtFraction,
      summarize: (transcript) => deps.summarize(transcript, controller.signal),
      isAborted: () => controller.signal.aborted,
      abortInFlight: () => controller.abort(),
      onSuccess: (info) => {
        // Fire-and-forget; emitCompaction swallows writer errors internally.
        void emitCompaction(deps.traceWriter, {
          trigger: deps.trigger ?? 'manual',
          preCompactionMessages: info.olderSlice,
          summary: info.summary,
          keptTailCount: info.keptTailCount,
          keepLastNConfig: info.keepLastN,
          messagesBefore: info.messagesBefore,
          messagesAfter: info.messagesAfter,
          tokensSavedEstimate: info.tokensSavedEstimate,
        });
      },
    });
  } finally {
    deps.clearAbort(controller);
  }

  // Deterministic fallback: when turn-granular summarization found nothing to do
  // (short-but-full session — huge tool payloads inside the one kept turn), clear
  // large/old tool_result CONTENT in place. Additive: the summarization success
  // path above is untouched; this only runs on the no-op reasons.
  if (
    !result.compacted &&
    (result.reason === 'history-too-short' || result.reason === 'nothing-to-summarize')
  ) {
    const opts = resolveMicrocompactOptions(
      env.AFK_MICROCOMPACT_TOOL_RESULT_BYTES,
      env.AFK_MICROCOMPACT_KEEP_LAST,
    );
    const { blocksCleared, bytesReclaimed } = microcompactToolResults(deps.priorTurns, opts);
    if (blocksCleared > 0) {
      return {
        compacted: false,
        reason: 'microcompacted',
        messagesBefore,
        messagesAfter: deps.priorTurns.length,
        microcompaction: { blocksCleared, bytesReclaimed },
      };
    }
  }

  return result;
}
