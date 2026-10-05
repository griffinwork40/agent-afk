/**
 * History compaction handler for {@link OpenAICompatibleQuery}.
 *
 * Extracted from `query.ts` (350-code-line ceiling) — see issue #2565.
 * Mirrors anthropic-direct/query/compact-handler.ts.
 *
 * Context contract:
 *   The caller (OpenAICompatibleQuery) implements `CompactHandlerContext` and
 *   passes `this` directly, so every accessor reflects live instance state.
 *   Never pass a plain object literal with getters — `this` inside those would
 *   be the literal, not the query instance (known pitfall, issue #2565).
 *
 * Mutable fields accessed live through the context:
 *   - `currentModel` — changes on setModel()
 *   - `closed` — set by close()
 *   - `responsesCompactionUnavailable` — latched by summarizeViaResponses()
 *   - `lastUsage` — updated each turn
 *
 * @module agent/providers/openai-compatible/query/compact-handler
 */

import OpenAI from 'openai';
import type { CompactionTrigger } from '../../../../agent/trace/types.js';
import type { ProviderCompactResult, ProviderUsage } from '../../../provider.js';
import { autoCompactLimitFor } from '../../../model-limits.js';
import {
  contextWindowTokensUsed,
  contextFullnessFraction,
} from '../../shared/auto-compact.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { errorMessage } from '../../../../utils/errors.js';
import {
  COMPACT_SYSTEM_PROMPT,
  wrapTranscriptForSummary,
} from '../../shared/compaction.js';
import { compactOpenAIHistory, readShrinkFraction } from '../compact.js';
import { oneShotResponses } from '../oneshot.js';
import { getErrorStatus } from './retry.js';
import { buildCompactSummarize } from './compact-summarize.js';
import { provesResponsesCompactionUnsupported } from './compaction-guard.js';
import type { OpenAIJournalWiring } from './journal-wiring.js';
import type { OpenAIMessage } from '../messages.js';
import type { WireMode } from '../responses-config.js';
import type { AbortCoordinator } from '../../shared/abort-coordinator.js';
import type { TraceSink } from '../../../trace/index.js';
import { env } from '../../../../config/env.js';

/** Live accessors the compaction handler needs from the owning query instance. */
export interface CompactHandlerContext {
  readonly client: OpenAI;
  readonly wireMode: WireMode;
  readonly abort: AbortCoordinator;
  readonly priorTurns: OpenAIMessage[];
  readonly journal: OpenAIJournalWiring;
  readonly traceWriter: TraceSink | undefined;
  readonly opts: {
    readonly auth: { readonly apiKey: string | null; readonly source: string };
    readonly config: { readonly subagentId?: string };
  };
  /** Mutable — must read live; changed by setModel(). */
  readonly currentModel: string;
  /** Mutable — set by close(). */
  readonly closed: boolean;
  /** Mutable — updated by finishTurn and mid-round live refresh. */
  lastUsage: ProviderUsage | null;
  /** Read-only latch — `true` when the Responses-wire backend provably refuses compaction. */
  readonly responsesCompactionUnavailable: boolean;
  /**
   * Latch the responses-compaction-unavailable flag. The ONLY legitimate writer;
   * replaces direct field assignment so the backing field can stay private on the
   * owning class. Called at most once per session.
   */
  markResponsesCompactionUnavailable(): void;
}

/**
 * Delegate for the Responses-wire summarize path. Separated from
 * `runCompactHistory` so the latch write stays on the context object.
 */
export async function runSummarizeViaResponses(
  ctx: CompactHandlerContext,
  transcript: string,
  signal: AbortSignal,
  model: string,
): Promise<string> {
  try {
    return await oneShotResponses({
      client: ctx.client,
      model,
      system: COMPACT_SYSTEM_PROMPT,
      user: wrapTranscriptForSummary(transcript),
      isChatGptBackend: ctx.opts.auth.source === 'chatgpt-oauth',
      maxTokens: 1024,
      signal,
    });
  } catch (err) {
    if (!signal.aborted && provesResponsesCompactionUnsupported(err)) {
      ctx.markResponsesCompactionUnavailable();
      const status = getErrorStatus(err);
      void emitSessionPhase(ctx.traceWriter, {
        phase: 'compaction_disabled',
        metadata: {
          wire: 'responses',
          reason: 'responses-compaction-unavailable',
          error: errorMessage(err),
          ...(status !== undefined ? { status } : {}),
        },
      });
    }
    throw err;
  }
}

/**
 * Run one compaction pass for the session, driven by `trigger`.
 *
 * Reads all mutable state live through `ctx` (which is the owning
 * `OpenAICompatibleQuery` instance) — no snapshot is taken.
 */
export async function runCompactHistory(
  ctx: CompactHandlerContext,
  trigger: CompactionTrigger,
): Promise<ProviderCompactResult> {
  const messagesBefore = ctx.priorTurns.length;
  if (ctx.opts.auth.apiKey === null) {
    return { compacted: false, reason: 'no-usable-auth', messagesBefore, messagesAfter: messagesBefore };
  }
  if (ctx.wireMode === 'responses' && ctx.responsesCompactionUnavailable) {
    // Invariant: the latch disables the SUMMARIZE TRANSPORT only — never the
    // deterministic fallback. A prior responses-wire summarize proved the
    // backend refuses the throwaway summarize turn, so re-issuing a doomed
    // request every turn boundary is pure waste. But microcompaction is
    // no-LLM and no-network: it clears large/old tool_result CONTENT in place,
    // so it still works when the backend refuses everything. Skipping it here
    // would leave the session unable to reclaim context by ANY mechanism,
    // which overshoots "no-op cheaply" into "guarantee an eventual overflow".
    // Mirrors the fallback `compactOpenAIHistory` runs on its own no-op
    // reasons (compact.ts) — same options source, same result shape.
    const micro = ctx.journal.microcompactFallback(ctx.priorTurns);
    if (micro) return micro;
    return {
      compacted: false,
      reason: 'responses-compaction-unavailable',
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  }
  const compactModel = env.AFK_COMPACT_MODEL ?? ctx.currentModel;
  const usedFraction = contextFullnessFraction(
    contextWindowTokensUsed(ctx.lastUsage ?? {}),
    autoCompactLimitFor(ctx.currentModel),
  );

  const summarize = buildCompactSummarize({
    wireMode: ctx.wireMode,
    client: ctx.client,
    compactModel,
    compactModelRaw: env.AFK_COMPACT_MODEL,
    summarizeViaResponses: (t, s, m) => runSummarizeViaResponses(ctx, t, s, m),
    sessionKey: ctx,
  });

  const compactResult = await compactOpenAIHistory({
    priorTurns: ctx.priorTurns,
    usedFraction,
    shrinkAtFraction: readShrinkFraction(),
    summarize,
    isClosed: ctx.closed, // boolean snapshot — inherited from pre-split behaviour; compactOpenAIHistory accepts boolean, not a function
    isIdle: ctx.abort.isIdle(),
    // Invariant: compaction opens a real abort scope through the same
    // coordinator the turn loop uses, so `interrupt()` cancels an
    // in-flight summarize. Note `begin()` also DRAINS a reason parked
    // between turns — an ESC that lands at the turn boundary now
    // pre-aborts the auto-compaction that fires there (and consumes the
    // reason) instead of letting it run. This matches
    // anthropic-direct/query/compact-handler.ts; the previous
    // openai-only behaviour installed a controller without draining.
    beginAbort: () => ctx.abort.begin(),
    clearAbort: (controller) => ctx.abort.clear(controller),
    trigger,
    traceWriter: ctx.traceWriter,
  });
  ctx.journal.afterCompact(ctx.priorTurns, compactResult);
  return compactResult;
}
