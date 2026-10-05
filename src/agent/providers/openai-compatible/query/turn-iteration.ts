/**
 * One iteration of the openai-compatible tool loop: one model call + chunk
 * drain, plus the `finishTurn` terminal helper.
 *
 * Extracted from `query.ts` (350-code-line ceiling) — see issue #2565.
 *
 * Context contract:
 *   The caller (OpenAICompatibleQuery) implements `IterationContext` and passes
 *   `this` directly, so every getter read reflects the live instance field.
 *   Never pass a plain object literal with getters — `this` inside those getters
 *   would be the literal, not the query instance (the pitfall that broke 145
 *   tests in a prior scouting attempt).
 *
 * @module agent/providers/openai-compatible/query/turn-iteration
 */

import OpenAI from 'openai';
import type { AgentConfig } from '../../../types/config-types.js';
import type { ProviderEvent, ProviderUsage } from '../../../provider.js';
import { buildMessages, buildUserContent, type OpenAIMessage } from '../messages.js';
import { supportsVision } from '../../../model-capabilities.js';
import {
  translateChunk,
  type OpenAIChunk,
} from '../translate.js';
import { translateResponsesEvent, type ResponsesStreamEvent } from '../responses-translate.js';
import { isClaudeFamilyModel, type WireMode } from '../responses-config.js';
import { PLAN_MODE_ADDENDUM_TEXT } from '../../shared/plan-mode-addendum.js';
import { AFK_MODE_ADDENDUM_TEXT } from '../../shared/afk-mode-addendum.js';
import {
  TOOL_USE_LOOP_CAPPED,
  WIND_DOWN_NOTE,
} from '../../shared/tool-loop-cap.js';
import {
  SOFT_DEADLINE_WIND_DOWN,
  SOFT_DEADLINE_NOTE,
} from '../../shared/soft-deadline.js';
import type { OpenAIFunctionTool } from '../loop.js';
import {
  buildChatCompletionsRequestBody,
  buildResponsesRequestBody,
} from './request-body.js';
import { driveStream, type IterationResult } from './stream-drive.js';
import type { FastTierSession } from './fast-tier-session.js';
import type { OpenAIJournalWiring } from './journal-wiring.js';
import { chatGptClaudeModelError, clarifyResponsesError } from './chatgpt-backend-errors.js';
import type { TraceSink } from '../../../trace/index.js';
import type { OpenAIAuthResolution } from '../auth.js';

/** Live accessors the iteration driver needs from the owning query instance. */
export interface IterationContext {
  /** Current model id — mutable between turns via setModel. */
  readonly currentModel: string;
  /** Current permission mode — mutable via setPermissionMode. */
  readonly currentPermissionMode: string;
  /** Whether the session is closed. */
  readonly closed: boolean;
  readonly initSessionId: string;
  readonly wireMode: WireMode;
  readonly useOpenAIPricing: boolean;
  readonly opts: {
    readonly config: AgentConfig;
    readonly auth: OpenAIAuthResolution;
  };
  readonly client: OpenAI;
  readonly traceWriter: TraceSink | undefined;
  readonly fastTier: FastTierSession;
  readonly journal: OpenAIJournalWiring;
  readonly priorTurns: OpenAIMessage[];
  /** Active tool catalog for this turn; undefined when no tools are available. */
  activeOpenAITools(): OpenAIFunctionTool[] | undefined;
}

/** Accessors needed by `finishTurn`. Subset of `IterationContext`. */
export interface FinishTurnContext {
  readonly initSessionId: string;
  readonly journal: OpenAIJournalWiring;
  readonly priorTurns: OpenAIMessage[];
  /** Set to the final usage on each turn.completed emission. */
  lastUsage: ProviderUsage | null;
}

/**
 * Emit the terminal `turn.completed` event and sync the journal.
 *
 * Invariant: every non-error exit from `_runTurnInner` MUST call this once so
 * the persistent stream consumer (agent-session.ts) unblocks its turn loop.
 * Real stream errors are the one exception — their already-yielded `error`
 * event is itself terminal.
 *
 * `lastUsage` is updated before the yield so `getContextUsage()` reads the
 * correct value even if the outer consumer breaks early.
 */
export function* finishTurn(
  ctx: FinishTurnContext,
  accumulatedUsage: ProviderUsage,
  turnStartTime: number,
): Generator<ProviderEvent> {
  ctx.lastUsage = accumulatedUsage;
  ctx.journal.sync(ctx.priorTurns); // commit point: turn end (final assistant message)
  yield {
    type: 'turn.completed',
    usage: { ...accumulatedUsage, durationMs: Date.now() - turnStartTime },
    sessionId: ctx.initSessionId,
  };
}

/**
 * Build a user-turn message and push it onto `priorTurns`.
 * Exported for use in `runTurnInner`.
 */
export function pushUserTurn(
  ctx: IterationContext,
  content: import('../../../provider.js').ProviderUserTurn['content'],
): void {
  const vision = supportsVision(ctx.currentModel);
  ctx.priorTurns.push({
    role: 'user',
    content: buildUserContent(content, { vision, model: ctx.currentModel }),
  });
}

/**
 * One iteration = one model call + chunk drain.
 *
 * Returns `null` when the stream errored or was aborted (events for those
 * cases were already yielded). Otherwise returns a record describing whether
 * tools need to be dispatched.
 *
 * Note: yields delta events (text/reasoning) as they arrive but does NOT
 * yield `assistant.message` / `turn.completed` — those are the caller's
 * responsibility once the loop settles.
 */
export async function* runIteration(
  ctx: IterationContext,
  controller: AbortController,
  vision: boolean,
  windDown: typeof TOOL_USE_LOOP_CAPPED | typeof SOFT_DEADLINE_WIND_DOWN | null,
): AsyncGenerator<ProviderEvent, IterationResult | null> {
  ctx.journal.sync(ctx.priorTurns); // commit point: what is about to be sent
  const messages = buildMessages({
    config: ctx.opts.config,
    ...ctx.journal.legacyResumeHistory(),
    priorTurns: ctx.priorTurns,
    vision,
  });

  // Inject plan-mode / AFK-mode posture addendum onto the system message.
  if (messages[0]?.role === 'system') {
    const addendum =
      ctx.currentPermissionMode === 'plan' ? PLAN_MODE_ADDENDUM_TEXT :
      ctx.currentPermissionMode === 'autonomous' ? AFK_MODE_ADDENDUM_TEXT :
      null;
    if (addendum !== null) {
      messages[0] = {
        ...messages[0],
        content: (messages[0].content as string) + '\n\n' + addendum,
      };
    }
  }

  // Wind-down round: strip tools and append budget note to THIS request only.
  if (windDown !== null) {
    const note = windDown === TOOL_USE_LOOP_CAPPED ? WIND_DOWN_NOTE : SOFT_DEADLINE_NOTE;
    messages.push({ role: 'user', content: note });
  }
  const activeTools = windDown !== null ? undefined : ctx.activeOpenAITools();

  // Shared context for the retry/stream-drive skeleton (query/stream-drive.ts).
  const driveCtx = {
    controller,
    traceWriter: ctx.traceWriter,
    initSessionId: ctx.initSessionId,
    currentModel: ctx.currentModel,
    isClosed: () => ctx.closed,
  };

  if (ctx.wireMode === 'responses') {
    const isChatGptBackend = ctx.opts.auth.source === 'chatgpt-oauth';

    if (isChatGptBackend && isClaudeFamilyModel(ctx.currentModel)) {
      yield { type: 'error', error: chatGptClaudeModelError(ctx.currentModel) };
      return null;
    }

    const requestBody = buildResponsesRequestBody({
      model: ctx.currentModel,
      messages,
      activeTools,
      maxOutputTokens: ctx.opts.config.maxOutputTokens,
      effort: ctx.opts.config.effort, temperature: ctx.opts.config.temperature,
      isChatGptBackend,
    });

    const result = yield* driveStream<ResponsesStreamEvent>(driveCtx, {
      createStream: async (signal) => (await ctx.fastTier.create(requestBody, (body) =>
        ctx.client.responses.create(body as never, { signal }))) as unknown as AsyncIterable<ResponsesStreamEvent>,
      translate: (event, state) => {
        ctx.fastTier.observeResponsesEvent(event);
        return translateResponsesEvent(event, state, ctx.initSessionId);
      },
      clarifyError: (err) => clarifyResponsesError(err, isChatGptBackend, ctx.currentModel),
    });
    yield* ctx.fastTier.drainNotice(ctx.initSessionId);
    return result;
  } else {
    const requestBody = buildChatCompletionsRequestBody({
      model: ctx.currentModel,
      messages,
      activeTools,
      maxOutputTokens: ctx.opts.config.maxOutputTokens,
      effort: ctx.opts.config.effort, temperature: ctx.opts.config.temperature,
    });

    const result = yield* driveStream<OpenAIChunk>(driveCtx, {
      createStream: async (signal) => (await ctx.fastTier.create(requestBody, (body) =>
        ctx.client.chat.completions.create(body as never, { signal }))) as unknown as AsyncIterable<OpenAIChunk>,
      translate: (event, state) => {
        ctx.fastTier.observeChatChunk(event);
        return translateChunk(event, state, ctx.initSessionId);
      },
      clarifyError: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
    yield* ctx.fastTier.drainNotice(ctx.initSessionId);
    return result;
  }
}
