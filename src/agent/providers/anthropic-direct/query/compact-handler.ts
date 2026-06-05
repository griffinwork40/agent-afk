/**
 * History compaction handler for {@link AnthropicDirectQuery}.
 *
 * Pure orchestration function — takes injected collaborators
 * ({@link SessionState}, {@link AbortCoordinator}, {@link RetryLayer},
 * trace writer, session id) and runs one compaction pass:
 *
 *   1. Bail with a typed reason if the session is closed or a turn is
 *      already in flight (the latter via `abort.isIdle()`).
 *   2. Locate the compaction boundary; bail if there's nothing older
 *      than the keep-last-N tail to summarize.
 *   3. Begin a fresh abort scope (so `interrupt()` cancels the
 *      summarization request cleanly), build a request via
 *      `compact.ts`'s helpers, stream it through the current SDK
 *      client (read via `retry.client` so we see the post-401-swap
 *      reference), and collect the assistant text.
 *   4. On a non-empty summary: splice `state.messages` in place,
 *      emit a witness-layer `compaction` event, and return the
 *      success result.
 *
 * Mutates `state.messages` in place on success. Leaves history
 * untouched on every failure path (closed, in-flight, too-short,
 * nothing-to-summarize, aborted, summarization-failed, empty-summary).
 *
 * # Why the helpers live here
 *
 * `readKeepLastN`, `readCompactModel`, and `collectStreamText` are
 * file-private utilities that are only meaningful in the compaction
 * pipeline. They moved with the function so query.ts has no leftover
 * compaction surface.
 *
 * @module agent/providers/anthropic-direct/query/compact-handler
 */

import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'node:crypto';
import type { ProviderCompactResult } from '../../../provider.js';
import { buildRequestHeaders } from '../auth.js';
import {
  applyCompaction,
  buildSummarizationRequest,
  estimateTokensSaved,
  findCompactionBoundary,
} from '../compact.js';
import { emitCompaction } from '../../../trace/emit.js';
import type { AnthropicClientLike } from '../types.js';
import type { SessionState } from './session-state.js';
import type { AbortCoordinator } from './abort-coordinator.js';
import type { RetryLayer } from './retry-layer.js';
import { env } from '../../../../config/env.js';

const DEFAULT_COMPACT_KEEP_LAST_TURNS = 2;
const DEFAULT_COMPACT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_COMPACT_MAX_TOKENS = 1024;

/** Injected dependencies for {@link compactHistory}. */
export interface CompactHandlerDeps {
  state: SessionState;
  abort: AbortCoordinator;
  retry: RetryLayer;
  initSessionId: string;
  traceWriter?: import('../../../trace/index.js').TraceWriter;
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

  const keepLastN = readKeepLastN();
  const boundary = findCompactionBoundary(state.messages, keepLastN);
  if (boundary < 0) {
    return {
      compacted: false,
      reason: 'history-too-short',
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  }
  if (boundary === 0) {
    // Kept tail starts at message 0 — nothing older to summarize.
    // History is not too short; the entire history falls within the keep
    // window. Emit a distinct reason so surfaces can give accurate feedback.
    return {
      compacted: false,
      reason: 'nothing-to-summarize',
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  }

  const olderSlice = state.messages.slice(0, boundary);
  const compactModel = readCompactModel();
  const params = buildSummarizationRequest(
    olderSlice,
    compactModel,
    DEFAULT_COMPACT_MAX_TOKENS,
  );

  const controller = abort.begin();

  let summary: string;
  try {
    if (controller.signal.aborted) {
      return {
        compacted: false,
        reason: 'aborted',
        messagesBefore,
        messagesAfter: messagesBefore,
      };
    }

    const headers = buildRequestHeaders(
      retry.authMode,
      initSessionId,
      randomUUID(),
    );
    // Read `client` via the retry layer's getter so we always see the
    // post-401-swap reference, never a stale snapshot.
    const client = retry.client as unknown as AnthropicClientLike;
    const stream = (await Promise.resolve(
      client.messages.create(params, {
        headers,
        signal: controller.signal,
      }),
    )) as AsyncIterable<RawMessageStreamEvent>;

    summary = await collectStreamText(stream);
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        compacted: false,
        reason: 'aborted',
        messagesBefore,
        messagesAfter: messagesBefore,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      compacted: false,
      reason: 'summarization-failed: ' + msg,
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  } finally {
    abort.clear(controller);
  }

  if (summary.trim().length === 0) {
    return {
      compacted: false,
      reason: 'empty-summary',
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  }

  const tokensSavedEstimate = estimateTokensSaved(
    state.messages,
    boundary,
    summary,
  );
  const newMessages = applyCompaction(state.messages, boundary, summary);
  state.messages.splice(0, state.messages.length, ...newMessages);
  const messagesAfter = state.messages.length;

  // Witness layer: emit `compaction` AFTER the splice so messagesAfter
  // reflects the post-mutation length, but `olderSlice` was captured
  // pre-splice so it still carries the full pre-compaction transcript.
  // The writer is responsible for sidecar-ing `preCompactionMessages`
  // to a path-addressed file and rewriting the payload to its persisted
  // form — see CompactionPayloadPersistedSchema. Fire-and-forget;
  // emitCompaction swallows writer errors so a broken sink never
  // blocks the compaction's return.
  void emitCompaction(traceWriter, {
    trigger: 'manual',
    preCompactionMessages: olderSlice,
    summary,
    keptTailCount: messagesBefore - boundary,
    keepLastNConfig: keepLastN,
    messagesBefore,
    messagesAfter,
    tokensSavedEstimate,
  });

  return {
    compacted: true,
    messagesBefore,
    messagesAfter,
    tokensSavedEstimate,
  };
}

function readKeepLastN(): number {
  const raw = env.AFK_COMPACT_KEEP_LAST_TURNS;
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_COMPACT_KEEP_LAST_TURNS;
}

function readCompactModel(): string {
  const raw = env.AFK_COMPACT_MODEL;
  if (raw !== undefined && raw.length > 0) return raw;
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
