/**
 * History compaction handler for {@link AnthropicDirectQuery}.
 *
 * Pure orchestration function — takes injected collaborators
 * ({@link SessionState}, {@link AbortCoordinator}, {@link RetryLayer},
 * trace writer, session id) and runs one compaction pass:
 *
 *   1. Bail with a typed reason if the session is closed or a turn is
 *      already in flight (the latter via `abort.isIdle()`).
 *   2. Delegate boundary selection, transcript render, summarize, and
 *      splice to {@link runCompactionCore} from `shared/compaction.ts`.
 *   3. On a non-empty summary: splice `state.messages` in place,
 *      emit a witness-layer `compaction` event, and return the
 *      success result.
 *   4. On any no-op result: run deterministic tool-result microcompaction
 *      as a fallback to reclaim context in short-but-full sessions.
 *
 * Mutates `state.messages` in place on success. Leaves history
 * untouched on every failure path (closed, in-flight, too-short,
 * nothing-to-summarize, aborted, summarization-failed, empty-summary).
 *
 * # Provider-specific elements
 *
 * The shared {@link runCompactionCore} owns the generic algorithm; this
 * file wires the Anthropic-specific collaborators:
 *   - `anthropicCompactionOps` — message-representation primitives
 *     (boundary walk, transcript render, preamble shape) from `compact.ts`.
 *   - The `summarize` closure — builds the `messages.create` request from
 *     the rendered transcript, streams it through the live SDK client
 *     (read via `retry.client` for post-401-swap freshness), and collects
 *     the text.
 *
 * @module agent/providers/anthropic-direct/query/compact-handler
 */

import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'node:crypto';
import type { ProviderCompactResult } from '../../../provider.js';
import { buildRequestHeaders } from '../auth.js';
import {
  anthropicCompactionOps,
  microcompactToolResults,
  COMPACT_SYSTEM_PROMPT,
} from '../compact.js';
import {
  readKeepLastN,
  readShrinkFraction,
  resolveMicrocompactOptions,
  runCompactionCore,
  wrapTranscriptForSummary,
} from '../../shared/compaction.js';
import { resolveCrossProviderSummarize } from '../../shared/compact-summarizer.js';
import {
  contextFullnessFraction,
  contextWindowTokensUsed,
} from '../../shared/auto-compact.js';
import { autoCompactLimitFor } from '../../../model-limits.js';
import { emitCompaction } from '../../../trace/emit.js';
import { traceTransientRetry, traceExhaustedRetry } from '../../shared/transient-retry.trace.js';
import { DEFAULT_TRANSIENT_MAX_RETRIES } from '../../shared/transient-retry.js';
import { resolveModelId } from '../../../session/model-resolution.js';
import type { AnthropicClientLike } from '../types.js';
import type { SessionState } from './session-state.js';
import type { AbortCoordinator } from '../../shared/abort-coordinator.js';
import type { RetryLayer } from './retry-layer.js';
import { env } from '../../../../config/env.js';

const DEFAULT_COMPACT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_COMPACT_MAX_TOKENS = 1024;

/** Injected dependencies for {@link compactHistory}. */
export interface CompactHandlerDeps {
  state: SessionState;
  abort: AbortCoordinator;
  retry: RetryLayer;
  initSessionId: string;
  traceWriter?: import('../../../trace/index.js').TraceSink;
}

/**
 * Run one compaction pass. See module docs for the full flow.
 *
 * The abort scope spans only the summarization request — once the
 * stream is drained the controller is cleared in a `finally`, so
 * the post-splice / witness-emit work runs without holding the slot
 * (which the next turn-start would otherwise see as `turn-in-flight`).
 */
export async function compactHistory(
  deps: CompactHandlerDeps,
): Promise<ProviderCompactResult> {
  const { state, abort, retry, initSessionId, traceWriter } = deps;
  const messagesBefore = state.messages.length;

  if (state.closed) {
    return {
      compacted: false,
      reason: 'session-closed',
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  }
  if (!abort.isIdle()) {
    return {
      compacted: false,
      reason: 'turn-in-flight',
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  }

  const controller = abort.begin();

  // Token-fullness fraction for adaptive keep-window: a short-but-full session
  // (few turns, huge tool exchanges) would otherwise report history-too-short /
  // nothing-to-summarize. Measuring against the same working budget as the
  // auto-compaction trigger (autoCompactLimitFor) lets the boundary relax the
  // keep-window when we are near the limit.
  const usedFraction = contextFullnessFraction(
    contextWindowTokensUsed(state.lastUsage ?? {}),
    autoCompactLimitFor(state.requestedModel),
  );

  // Session summarize closure: Anthropic streaming path. Used unchanged when
  // AFK_COMPACT_MODEL is unset or resolves to the same (anthropic) family.
  const sessionSummarize = async (transcript: string, signal?: AbortSignal): Promise<string> => {
    const effectiveSignal = signal ?? controller.signal;
    if (effectiveSignal.aborted) {
      throw new Error('aborted');
    }
    const compactModel = readCompactModel();
    const headers = buildRequestHeaders(
      retry.authMode,
      initSessionId,
      randomUUID(),
    );
    // Read `client` via the retry layer's getter so we always see the
    // post-401-swap reference, never a stale snapshot.
    const client = retry.client as unknown as AnthropicClientLike;
    const stream = (await Promise.resolve(
      client.messages.create(
        {
          model: compactModel,
          max_tokens: DEFAULT_COMPACT_MAX_TOKENS,
          system: COMPACT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: wrapTranscriptForSummary(transcript) }],
          stream: true,
        },
        { headers, signal: effectiveSignal },
      ),
    )) as AsyncIterable<RawMessageStreamEvent>;
    return collectStreamText(stream);
  };

  // Cross-provider resolution: if AFK_COMPACT_MODEL names a foreign-family
  // model, replace sessionSummarize with a foreign one-shot closure. On same
  // family (or unset), returns sessionSummarize unchanged — no extra overhead.
  const summarize = resolveCrossProviderSummarize(
    'anthropic-direct',
    sessionSummarize,
    env.AFK_COMPACT_MODEL,
    retry,
  );

  let result: ProviderCompactResult;
  try {
    result = await runCompactionCore<import('@anthropic-ai/sdk/resources').MessageParam>({
      messages: state.messages,
      ops: anthropicCompactionOps,
      keepLastN: readKeepLastN(),
      usedFraction,
      shrinkAtFraction: readShrinkFraction(),
      summarize: (transcript: string) => summarize(transcript, controller.signal),
      isAborted: () => controller.signal.aborted,
      abortInFlight: () => controller.abort(),
      onSuccess: (info) => {
        // Fire-and-forget; emitCompaction swallows writer errors internally.
        void emitCompaction(traceWriter, {
          trigger: 'manual',
          preCompactionMessages: info.olderSlice,
          summary: info.summary,
          keptTailCount: info.keptTailCount,
          keepLastNConfig: info.keepLastN,
          messagesBefore: info.messagesBefore,
          messagesAfter: info.messagesAfter,
          tokensSavedEstimate: info.tokensSavedEstimate,
        });
      },
      onRetry: traceTransientRetry(traceWriter, 'compaction', DEFAULT_TRANSIENT_MAX_RETRIES),
      onExhausted: traceExhaustedRetry(traceWriter, 'compaction', DEFAULT_TRANSIENT_MAX_RETRIES),
      signal: controller.signal,
    });
  } finally {
    abort.clear(controller);
  }

  // Deterministic microcompaction: run unconditionally after any compaction
  // attempt so large tool results in the kept tail are also cleared. The
  // sentinel guard inside microcompactToolResults (`isMicrocompactPlaceholder`)
  // prevents double-clearing any block already replaced in a prior pass.
  const opts = readMicrocompactOptions();
  const { blocksCleared, bytesReclaimed, firstClearedIndex } = microcompactToolResults(state.messages, opts);
  if (blocksCleared > 0 && !result.compacted) {
    return {
      compacted: false,
      reason: 'microcompacted',
      messagesBefore,
      messagesAfter: state.messages.length,
      microcompaction: { blocksCleared, bytesReclaimed, ...(firstClearedIndex !== undefined ? { firstClearedIndex } : {}) },
    };
  }

  return result;
}

/** Resolve the microcompaction threshold/keep-last from env (see shared resolver). */
function readMicrocompactOptions(): { thresholdBytes: number; keepLast: number; delegationThresholdBytes: number } {
  return resolveMicrocompactOptions(
    env.AFK_MICROCOMPACT_TOOL_RESULT_BYTES,
    env.AFK_MICROCOMPACT_KEEP_LAST,
    env.AFK_MICROCOMPACT_DELEGATION_BYTES,
  );
}

function readCompactModel(): string {
  const raw = env.AFK_COMPACT_MODEL;
  // Invariant: the Anthropic Messages API rejects short aliases like `'haiku'`
  // (404 `model: <alias> not_found` under OAuth — see the note in oneshot.ts).
  // Every other API path resolves the alias to a full model id via
  // resolveModelId before messages.create (query.ts, oneshot.ts, index.ts);
  // the compact summarizer must do the same, or a configured AFK_COMPACT_MODEL
  // alias reaches the API raw and 404s mid-compaction. resolveModelId returns
  // the full id for known aliases and passes anything else through unchanged.
  if (raw !== undefined && raw.length > 0) return resolveModelId(raw) ?? raw;
  return DEFAULT_COMPACT_MODEL;
}

/**
 * Drain the streaming `messages.create` response and return the
 * concatenated assistant text. Tool-use blocks are ignored — the
 * summarization request is built without tools so the model shouldn't
 * emit any.
 */
async function collectStreamText(
  events: AsyncIterable<RawMessageStreamEvent>,
): Promise<string> {
  let text = '';
  for await (const evt of events) {
    if (evt.type === 'content_block_delta') {
      const delta = evt.delta as { type?: string; text?: string };
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
      }
    }
  }
  return text;
}
