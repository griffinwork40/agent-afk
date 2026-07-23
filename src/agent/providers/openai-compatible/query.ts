/**
 * OpenAI-compatible ProviderQuery implementation.
 *
 * Owns one OpenAI client + one logical session (a sequence of Chat
 * Completions calls sharing message history). Slice 3 adds tool dispatch
 * via the shared `SessionToolDispatcher` (the same dispatcher anthropic-direct
 * uses) — hooks fire from there, permission checks land there, and the
 * built-in handlers (`bash`, `read_file`, `write_file`, `edit_file`, `glob`,
 * `grep`, `list_directory`, `send_telegram`) are reused without copying.
 *
 * Lifecycle:
 *   - constructor is synchronous; emits `session.init` on first iterator pull
 *   - main loop awaits user turns from `promptStream`, races against
 *     `closedPromise` so `close()` unblocks a "waiting for next turn" state
 *   - each user turn opens a new AbortController; `interrupt()` aborts it
 *   - `runTurn` iterates model→tools→model until the model stops calling tools
 *     (or the tool-round cap fires — see shared/tool-loop-cap.ts — after which
 *     one tools-stripped wind-down round runs, matching anthropic-direct/loop.ts)
 *
 * History compaction is supported via {@link OpenAICompatibleQuery.compact},
 * which reuses this session's client to summarize the older transcript through
 * the provider-neutral core in `shared/compaction.ts` — see `./compact.ts`.
 * Auto-compaction is wired too: when `config.autoCompact` resolves a threshold,
 * the turn-boundary check in {@link run} fires `compactHistory('token_threshold')`
 * once the context-window footprint crosses it (mirrors anthropic-direct/query.ts).
 *
 * Things deliberately deferred:
 *   - File checkpointing / rewindFiles (deferred — `canRewind: false`)
 *
 * @module agent/providers/openai-compatible/query
 */

import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../../types/config-types.js';
import { emitSessionPhase } from '../../trace/emit.js';
import { pathContainmentBypassed } from '../../permission-policy.js';
import type { TraceWriter } from '../../trace/index.js';
import type { CompactionTrigger } from '../../trace/types.js';
import type {
  ProviderQuery,
  ProviderEvent,
  ProviderUserTurn,
  ProviderSessionInfo,
  ProviderContextUsage,
  ProviderRewindResult,
  ProviderModelInfo,
  ProviderCommandInfo,
  ProviderAgentInfo,
  ProviderMcpServerStatus,
  ProviderAccountInfo,
  ProviderUsage,
  ProviderCompactResult,
} from '../../provider.js';
import { sumProviderUsage } from '../../usage.js';
import { contextLimitFor, autoCompactLimitFor } from '../../model-limits.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { collectSupportedCommands } from '../shared/supported-commands.js';
import { debugLog } from '../../../utils/debug.js';
import {
  resolveOpenAIAuth,
  formatAuthDiagnostic,
  type OpenAIAuthResolution,
  type AuthResolverDeps,
} from './auth.js';
import { buildMessages, buildUserContent, type OpenAIMessage } from './messages.js';
import { supportsVision } from '../../model-capabilities.js';
import {
  translateChunk,
  usageFromState,
  finalizedToolCalls,
  type OpenAIChunk,
  type StreamState,
} from './translate.js';
import {
  toolDefsToOpenAIFunctions,
  type OpenAIFunctionTool,
} from './loop.js';
import { translateResponsesEvent, type ResponsesStreamEvent } from './responses-translate.js';
import { resolveWireMode, envFlagEnabled, isClaudeFamilyModel, type WireMode } from './responses-config.js';
import { env } from '../../../config/env.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import type { ToolResult } from '../anthropic-direct/types.js';
import {
  contextWindowTokensUsed,
  contextFullnessFraction,
  buildContextUsageFields,
  shouldAutoCompact,
  resolveAutoCompactThreshold,
} from '../shared/auto-compact.js';
import { HookBlockedError, DenialCircuitBreakerError } from '../../../utils/errors.js';
import { COMPACT_SYSTEM_PROMPT, wrapTranscriptForSummary } from '../shared/compaction.js';
import { compactOpenAIHistory, readShrinkFraction } from './compact.js';
import { oneShotChatCompletion } from './oneshot.js';
import { PLAN_MODE_ADDENDUM_TEXT } from '../shared/plan-mode-addendum.js';
import { AFK_MODE_ADDENDUM_TEXT } from '../shared/afk-mode-addendum.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/handlers/exit-plan-mode.js';
import { summarizeToolInput } from '../shared/tool-input-summary.js';
import { dispatchAndAppendToolCalls } from './query/dispatch-append.js';
import {
  TOOL_USE_LOOP_CAPPED,
  WIND_DOWN_NOTE,
  resolveMaxToolIterations,
  shouldWindDown,
} from '../shared/tool-loop-cap.js';
import {
  normalizePermissionMode,
  resolveReasoningEffort,
} from './query/model-params.js';
import { resolveClientFactory } from './query/client.js';
import { driveStream, type IterationResult } from './query/stream-drive.js';
import {
  buildChatCompletionsRequestBody,
  buildResponsesRequestBody,
} from './query/request-body.js';

// Re-exported from the extracted query/ submodules so existing import sites
// (sibling tests + index.ts) keep resolving these from './query.js'.
export { __setRetryBaseDelay } from './query/retry.js';
export { __setOpenAIClientFactory } from './query/client.js';
export type { OpenAIClientFactory } from './query/client.js';
export { isOSeriesModel, mapEffortForOpenAI } from './query/model-params.js';
export { resolveReasoningEffort };

const PROVIDER_NAME = 'openai-compatible';

/** Construction options. */
export interface OpenAICompatibleQueryOptions {
  /** Pre-resolved auth. Carries the source tag for session.init. */
  auth: OpenAIAuthResolution;
  /** Optional baseURL override (NVIDIA NIM, Together, etc.). Defaults to OpenAI. */
  baseURL?: string;
  /** Model id, passed straight through to the API. */
  model: string;
  /** Synthetic session id emitted on `session.init` before the first wire call. */
  synthesizedSessionId: string;
  /** Caller-side prompt stream (lazy). */
  promptStream: AsyncIterable<ProviderUserTurn>;
  /** Full AgentConfig. */
  config: AgentConfig;
  /**
   * Tool dispatcher to route every tool call through. When omitted, tool
   * calls are not offered to the model (no `tools[]` in the request) and
   * the loop reduces to slice-2 text-only behavior. The harness's typical
   * wiring constructs a `SessionToolDispatcher` here so hooks, permissions,
   * and the shared handler set all just work.
   */
  toolDispatcher?: ToolDispatcher;
  /**
   * Provider callback invoked by `setPermissionMode()` to update the
   * provider-level `_currentPermissionMode` — the field the path-approval hook
   * reads via the provider's `getGrants().allowAll`. The path-approval half of
   * a live `/bypass` toggle (the file-tool half is the dispatcher's
   * `setAllowAll()`). Supplied by `OpenAICompatibleProvider.query()`.
   */
  onPermissionMode?: (mode: string) => void;
  /** Optional MCP manager — populates `session.init` and `mcpServerStatus()`. */
  mcpManager?: import('../../mcp/index.js').McpManager;
  /**
   * Force the OpenAI Responses API instead of Chat Completions (the public,
   * API-key opt-in — equivalent to `AFK_OPENAI_USE_RESPONSES=1`). The
   * ChatGPT-subscription path (`auth.source === 'chatgpt-oauth'`) selects
   * Responses automatically regardless of this flag.
   */
  useResponsesApi?: boolean;
  /**
   * Witness-layer trace writer. When provided, `loop_start`/`loop_end`/
   * `model_ttfb` session_phase events and `tool_call` started/completed
   * events are emitted — mirroring the anthropic-direct provider's trace
   * coverage. All emit calls are fire-and-forget; a broken writer never
   * stalls or crashes the session.
   */
  traceWriter?: TraceWriter;
}

/** Internal record used to drive the per-turn iteration loop. */
export class OpenAICompatibleQuery implements ProviderQuery {
  private readonly client: OpenAI;
  private readonly opts: OpenAICompatibleQueryOptions;
  private readonly initSessionId: string;
  private readonly toolDispatcher: ToolDispatcher | undefined;
  private readonly onPermissionMode?: (mode: string) => void;
  /** Pre-computed tool catalog — recomputed only if dispatcher.toolDefs changes (it doesn't today). */
  private readonly openAITools: OpenAIFunctionTool[] | undefined;
  /** Which wire this session speaks: Chat Completions (default) or Responses. */
  private readonly wireMode: WireMode;
  /** Witness-layer trace writer (optional). Mirrors RunTurnInput.traceWriter in anthropic-direct. */
  private readonly traceWriter: TraceWriter | undefined;

  /** Running conversation state for multi-turn sessions. */
  private priorTurns: OpenAIMessage[] = [];

  private currentModel: string;
  private currentPermissionMode: string;

  private abortController: AbortController | null = null;
  private pendingAbortReason: 'interrupted' | 'closed' | null = null;
  private closed = false;
  private closeResolve: (() => void) | null = null;
  private readonly closedPromise: Promise<'__closed__'>;

  /**
   * Last completed turn's accumulated usage — drives `getContextUsage()`.
   * Set on every `turn.completed` emission (see runTurn below). Mirrors
   * `anthropic-direct/query.ts:186` so the REPL status line gets a real
   * context-% reading on OpenAI models instead of falling through to the
   * sampler's local-stats approximation.
   */
  private lastUsage: ProviderUsage | null = null;

  /**
   * Auto-compaction threshold as a fraction of the context window (0–1), or
   * `undefined` when disabled. Resolved once from `config.autoCompact` through
   * the shared {@link resolveAutoCompactThreshold} — the same source the
   * anthropic-direct provider uses. Read by the turn-boundary auto-compaction
   * check in {@link run} and reported via `getInfo().isAutoCompactEnabled`.
   */
  private readonly autoCompactThreshold: number | undefined;

  constructor(opts: OpenAICompatibleQueryOptions) {
    this.opts = opts;
    this.initSessionId = opts.synthesizedSessionId;
    this.currentModel = opts.model;
    this.currentPermissionMode = normalizePermissionMode(opts.config.permissionMode);
    this.toolDispatcher = opts.toolDispatcher;
    this.onPermissionMode = opts.onPermissionMode;
    this.traceWriter = opts.traceWriter;
    this.autoCompactThreshold = resolveAutoCompactThreshold(opts.config.autoCompact);

    // Pre-compute the OpenAI tool catalog once. Only `SessionToolDispatcher`
    // (and not the structural `ToolDispatcher` minimal interface) exposes
    // `toolDefs`, so we duck-type the read.
    if (this.toolDispatcher) {
      const td = this.toolDispatcher as { toolDefs?: readonly unknown[] };
      if (Array.isArray(td.toolDefs) && td.toolDefs.length > 0) {
        this.openAITools = toolDefsToOpenAIFunctions(
          td.toolDefs as Parameters<typeof toolDefsToOpenAIFunctions>[0],
        );
      }
    }

    // Resolve the wire (Chat Completions vs Responses) once. The ChatGPT-
    // subscription path also supplies a baseURL override (the private ChatGPT
    // backend) + required headers; the public Responses opt-in supplies neither.
    // Env read goes through the central `env` module (env-access audit).
    const responsesOptIn =
      (opts.useResponsesApi ?? false) || envFlagEnabled(env.AFK_OPENAI_USE_RESPONSES);
    const wire = resolveWireMode(opts.auth, responsesOptIn);
    this.wireMode = wire.mode;

    if (opts.auth.apiKey === null) {
      this.client = null as unknown as OpenAI;
    } else {
      const ctor = resolveClientFactory();
      const clientOpts: { apiKey: string; baseURL?: string; defaultHeaders?: Record<string, string> } = {
        apiKey: opts.auth.apiKey,
      };
      const baseURL = wire.baseURL ?? opts.baseURL;
      if (baseURL !== undefined) clientOpts.baseURL = baseURL;
      if (wire.headers !== undefined) clientOpts.defaultHeaders = wire.headers;
      this.client = ctor(clientOpts);
    }

    this.closedPromise = new Promise<'__closed__'>((resolve) => {
      this.closeResolve = () => resolve('__closed__');
    });
  }

  /**
   * The OpenAI tool catalog to advertise for THIS turn. The plan-exit tool is
   * registered RESIDENT (see index.ts buildDispatcher) but is only actionable in
   * plan mode, so drop it from the advertised list on non-plan turns — mirroring
   * the anthropic-direct per-turn filter and composeSystem()'s live gating of the
   * plan-mode addendum. This is what makes `exit_plan_mode` become callable the
   * instant plan mode is entered mid-session, with no query rebuild. Returns
   * `undefined` when the catalog is empty/absent, matching the callers' guards.
   */
  private activeOpenAITools(): OpenAIFunctionTool[] | undefined {
    if (!this.openAITools) return undefined;
    if (this.currentPermissionMode === 'plan') return this.openAITools;
    const filtered = this.openAITools.filter(
      (t) => t.function.name !== EXIT_PLAN_MODE_TOOL_NAME,
    );
    return filtered.length > 0 ? filtered : undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    const info: ProviderSessionInfo = {
      sessionId: this.initSessionId,
      model: this.currentModel,
      permissionMode: this.currentPermissionMode,
      cwd: process.cwd(),
      tools: this.openAITools ? this.openAITools.map((t) => t.function.name) : [],
      slashCommands: [],
      skills: [],
      plugins: [],
      mcpServers: this.opts.mcpManager?.getServerStates().map((s) => ({
        name: s.serverName,
        status: s.status,
      })) ?? [],
      apiKeySource: this.opts.auth.source,
      version: PROVIDER_NAME,
    };
    yield { type: 'session.init', info };

    if (this.opts.auth.apiKey === null) {
      yield { type: 'error', error: new Error(formatAuthDiagnostic(this.opts.auth)) };
      return;
    }

    const promptIterator = this.opts.promptStream[Symbol.asyncIterator]();
    try {
      while (!this.closed) {
        const nextOrClose = await Promise.race([promptIterator.next(), this.closedPromise]);
        if (nextOrClose === '__closed__') break;
        const turnResult = nextOrClose as IteratorResult<ProviderUserTurn>;
        if (turnResult.done) break;

        yield* this.runTurn(turnResult.value.content);

        // Auto-compaction fires at the natural turn boundary — runTurn has
        // returned and its `finally` nulled `abortController`, so the handler's
        // idle guard passes and compaction never runs mid-tool-call. Mirrors
        // anthropic-direct/query.ts. `compactHistory` itself never throws (every
        // summarize failure is a typed no-op leaving history byte-for-byte
        // unchanged); only a PreCompact `block` decision throws HookBlockedError,
        // caught here to skip this turn's compaction without surfacing an error.
        if (this.autoCompactThreshold !== undefined && !this.closed) {
          const usage = this.lastUsage;
          const compactionLimit = autoCompactLimitFor(this.currentModel);
          if (usage !== null && compactionLimit > 0) {
            const usedTokens = contextWindowTokensUsed(usage);
            if (shouldAutoCompact(usedTokens, compactionLimit, this.autoCompactThreshold)) {
              try {
                await this.opts.config.hookRegistry?.dispatch({
                  event: 'PreCompact',
                  sessionId: this.initSessionId,
                  trigger: 'auto',
                });
                await this.compactHistory('token_threshold');
              } catch (compactErr) {
                if (!(compactErr instanceof HookBlockedError)) throw compactErr;
                // Hook blocked auto-compaction — continue the session normally.
              }
            }
          }
        }
      }
    } catch (iterErr) {
      const e = iterErr instanceof Error ? iterErr : new Error(String(iterErr));
      yield { type: 'error', error: e };
    } finally {
      try {
        await promptIterator.return?.();
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * Drive a single user turn through the model + tool loop.
   *
   * Loop shape (mirrors anthropic-direct/loop.ts:runTurn):
   *   1. Append user message to priorTurns.
   *   2. iteration: call model → stream → translate chunks.
   *   3. If finish_reason was tool_calls: dispatch via toolDispatcher,
   *      append assistant{tool_calls} + tool{result} to priorTurns, GOTO 2.
   *   4. Else: emit assistant.message + turn.completed, exit.
   *
   * Sums usage across iterations and emits a single `turn.completed` at the
   * end with the aggregate (mirrors how anthropic-direct accumulates usage
   * across the tool-call loop into one final event).
   */
  private async *runTurn(content: ProviderUserTurn['content']): AsyncGenerator<ProviderEvent> {
    const controller = new AbortController();
    this.abortController = controller;
    if (this.pendingAbortReason !== null && !controller.signal.aborted) {
      controller.abort(this.pendingAbortReason);
      this.pendingAbortReason = null;
    }
    if (controller.signal.aborted) return;

    // Wall-clock anchor for the REPL footer's `◦ Xs · $cost · N tok` line.
    // Set after the abort gate so an immediately-aborted turn doesn't yield
    // a duration anyway (it just returns silently — there's no
    // turn.completed yield on that path). Mirrors `loopStartTime` in
    // anthropic-direct/loop.ts.
    const turnStartTime = Date.now();
    const taskId = randomUUID();

    // Interrupt→halt latency instrumentation. Stamp the instant the turn signal
    // fires so the `finally` can report ESC→terminal wall-clock in the
    // `interrupt_halt` phase — the field-visible proof the ESC-lag fix keeps the
    // halt within an event-loop turn (openai@6 swallows a mid-stream abort, so
    // without abortableStream the halt lagged the parked read). One long-lived,
    // idempotent listener; registered only when a writer is present so a
    // no-trace session pays nothing. `close()` also aborts this controller but
    // with reason `'closed'`; the emit gate below fires ONLY for `'interrupted'`.
    let interruptedAt: number | null = controller.signal.aborted ? Date.now() : null;
    const onInterruptForTrace = (): void => {
      if (interruptedAt === null) interruptedAt = Date.now();
    };
    if (this.traceWriter && !controller.signal.aborted) {
      controller.signal.addEventListener('abort', onInterruptForTrace, { once: true });
    }

    // Witness layer: mark loop entry. Mirrors anthropic-direct/loop.ts:229.
    // Fire-and-forget — a broken trace writer must never stall the turn.
    void emitSessionPhase(this.traceWriter, { phase: 'loop_start' });
    try {
    yield* this._runTurnInner(content, controller, turnStartTime, taskId);
    } finally {
      controller.signal.removeEventListener('abort', onInterruptForTrace);
      // Interrupt→halt latency: emit ONLY when THIS turn ended because of an ESC
      // soft-stop (`interrupt()` aborts with reason `'interrupted'`). The abort
      // paths funnel through finishTurn, which yields the single terminal
      // `turn.completed` immediately before _runTurnInner returns into this
      // finally, so `Date.now()` here is that terminal instant; `interruptedAt`
      // is when the signal fired. A session `close()` (reason `'closed'`) and a
      // clean/error/capped end are excluded. Fire-and-forget; mirrors
      // anthropic-direct/loop.ts.
      if (interruptedAt !== null && controller.signal.reason === 'interrupted') {
        void emitSessionPhase(this.traceWriter, {
          phase: 'interrupt_halt',
          durationMs: Date.now() - interruptedAt,
          metadata: { provider: 'openai-compatible' },
        });
      }
      // Witness layer: loop_end fires regardless of which exit path fired —
      // abort, error, clean end-of-turn, or iteration cap. Mirrors
      // anthropic-direct/loop.ts:728–734.
      void emitSessionPhase(this.traceWriter, {
        phase: 'loop_end',
        durationMs: Date.now() - turnStartTime,
      });
    }
  }

  private async *_runTurnInner(
    content: ProviderUserTurn['content'],
    controller: AbortController,
    turnStartTime: number,
    taskId: string,
  ): AsyncGenerator<ProviderEvent> {

    // Vision capability is fixed for the turn (the model can only change
    // between turns via setModel). Computed once here and threaded into the
    // iteration + tool-dispatch so the user turn, history sanitize, and
    // tool-result image follow-up all agree. See issue #127 / model-capabilities.ts.
    const vision = supportsVision(this.currentModel);
    this.priorTurns.push({
      role: 'user',
      content: buildUserContent(content, { vision, model: this.currentModel }),
    });

    // Aggregate usage across all tool-loop iterations for this turn via the
    // shared sumProviderUsage helper. Critical: cache fields (cachedInputTokens,
    // cacheCreationTokens) must be take-latest, NOT cumulative — they describe
    // the per-call cache footprint of the same cached prefix on each iteration,
    // and summing them N-times across N iterations inflates the apparent
    // context by ~N×. See src/agent/usage.ts docstring.
    let accumulatedUsage: ProviderUsage = {
      stopReason: null,
      resultSubtype: 'success',
      isError: false,
    };
    let finalAssistantText = '';
    // Track the reasoning trace from the last iteration so DeepSeek-R1-class
    // thinking-mode providers see it echoed on the final assistant turn —
    // omitting it on the NEXT user-turn's request yields a 400 ("The
    // `reasoning_content` in the thinking mode must be passed back to the
    // API"). Stays empty for non-thinking providers (real OpenAI o-series
    // doesn't expose reasoning), in which case the field is omitted entirely.
    let finalReasoningText = '';

    const maxIterations = resolveMaxToolIterations(this.opts.config.maxToolUseIterations);
    // Set once the tool-round cap fires; the loop then runs ONE tools-stripped
    // "wind-down" round (runIteration's `windDown` arg) so the model synthesizes
    // a final answer instead of stopping silently — a silent stop reads as a
    // hang. `0` (the top-level default) means no cap. Shared with anthropic-direct
    // via shared/tool-loop-cap.ts so the two providers cannot drift apart.
    let capReached = false;
    let round = 0;
    // Cumulative count of tool CALLS dispatched across the whole turn — distinct
    // from `round`. `result.state` is a FRESH StreamState per iteration (see
    // runIteration → createStreamState), so finalizedToolCalls(result.state)
    // returns only THIS round's calls; a round can batch several, so we
    // accumulate. Emitted as the progress event's `toolUses` (below) so the
    // CLI's formatToolCallStat renders a truthful "N tool calls" (PR 508 codex
    // review, P2).
    let toolCallCount = 0;

    for (;;) {
      if (controller.signal.aborted) {
        if (this.abortController === controller) this.abortController = null;
        yield* this.finishTurn(accumulatedUsage, turnStartTime);
        return;
      }

      const result = yield* this.runIteration(controller, vision, capReached);
      if (result === null) {
        // runIteration bailed: either an abort/close (no event was yielded) or
        // a real stream error (an `error` event was already yielded). Mirror
        // anthropic-direct/loop.ts:410-432 — on abort/close emit a terminal
        // `turn.completed` so the persistent stream consumer
        // (agent-session.ts:sendMessageStreamInternal) unblocks its turn loop;
        // on a real stream error the already-yielded `error` event is itself
        // terminal, so skip turn.completed to avoid double-advancing turn state.
        if (this.abortController === controller) this.abortController = null;
        if (controller.signal.aborted || this.closed) {
          yield* this.finishTurn(accumulatedUsage, turnStartTime);
        }
        return;
      }

      const roundUsage = usageFromState(result.state);
      accumulatedUsage = sumProviderUsage(accumulatedUsage, roundUsage);
      // Context-window footprint for THIS round. Unlike Anthropic, OpenAI's
      // `prompt_tokens` (→ inputTokens) already INCLUDES cached tokens
      // (`cached_tokens` is a subset), so the window total is input + output —
      // adding cache would double-count. Computed from the single round (not
      // cumulative) and re-stamped each iteration; sumProviderUsage discards it.
      accumulatedUsage.contextWindowTokens =
        (roundUsage.inputTokens ?? 0) + (roundUsage.outputTokens ?? 0);
      // Mirror anthropic-direct: refresh lastUsage each round so
      // getContextUsage() shows live mid-turn context on the status line.
      // The post-loop assignment below still sets the final value.
      this.lastUsage = accumulatedUsage;
      if (result.text.length > 0) finalAssistantText = result.text;
      finalReasoningText = result.state.reasoningText;

      if (!result.needsToolDispatch) {
        // Model answered in text: a normal completion, or — when capReached —
        // the wind-down round's synthesized final answer. Emit terminal events.
        break;
      }

      if (capReached) {
        // Pathological: the wind-down round (tools stripped) still asked for a
        // tool. With none advertised this is only reachable if the model
        // fabricates a call. Honor the cap with a hard stop; do NOT dispatch.
        break;
      }

      // Tool-call path: dispatch, append history, loop.
      const denialTrip = yield* this.dispatchAndAppend(result.state, controller.signal, vision);
      // Denial circuit breaker (#546): a forked child hit N consecutive
      // path-approval read denials with no progress. Surface a LOUD terminal
      // `error` event (the subagent handle rethrows it into a structured
      // failure) and stop — never keep looping to the wall-clock budget. History
      // was appended by dispatchAndAppend, so the transcript is consistent. Skip
      // finishTurn: the error event is itself terminal (mirrors the stream-error
      // path above at `result === null`).
      if (denialTrip) {
        if (this.abortController === controller) this.abortController = null;
        yield { type: 'error', error: new DenialCircuitBreakerError(denialTrip.content) };
        return;
      }
      round += 1;

      {
        // `result.state` is per-round (fresh each runIteration), so this array
        // is THIS round's dispatched calls. Accumulate its length into the
        // running total — a round can batch multiple parallel calls.
        const roundCalls = finalizedToolCalls(result.state);
        toolCallCount += roundCalls.length;
        const lastCall = roundCalls.at(-1);
        const lastToolName = lastCall?.name;
        // Semantic summary — mirror anthropic-direct/loop.ts: tool name +
        // most informative argument via summarizeToolInput, so the progress
        // banner carries real signal instead of a bare iteration counter.
        // AccumulatedToolCall carries UNPARSED argumentsRaw (the streamed
        // JSON fragments joined); parse best-effort — a malformed payload
        // (mid-stream abort, shim quirks) degrades to the bare tool name.
        let lastCallInput: unknown;
        try {
          lastCallInput = lastCall ? JSON.parse(lastCall.argumentsRaw || '{}') : undefined;
        } catch {
          lastCallInput = undefined;
        }
        const lastToolHeadline = lastCall
          ? `${lastCall.name}${summarizeToolInput(lastCall.name, lastCallInput)}`
          : 'unknown';
        yield {
          type: 'progress',
          progress: {
            taskId,
            description: 'Working',
            summary: `round ${round}: ${lastToolHeadline}`,
            lastToolName,
            totalTokens: accumulatedUsage.totalTokens ?? 0,
            // Contract: `toolUses` is the cumulative COUNT OF TOOL CALLS so far
            // in this turn (not the round number), so downstream
            // formatToolCallStat renders "N tool calls" truthfully even when a
            // round batched parallel calls. The `summary` above legitimately
            // names the ROUND — leave it.
            toolUses: toolCallCount,
            durationMs: Date.now() - turnStartTime,
          },
          sessionId: this.initSessionId,
        };
      }

      if (controller.signal.aborted) {
        if (this.abortController === controller) this.abortController = null;
        yield* this.finishTurn(accumulatedUsage, turnStartTime);
        return;
      }

      if (shouldWindDown(round, maxIterations)) {
        // Cap reached. Run ONE more round with tools stripped + the budget note
        // (runIteration(windDown=true)) so the model produces a real final
        // answer instead of a silent stop. `capReached` fires this at most once;
        // the guard above hard-stops if the wind-down round still asks for a tool.
        capReached = true;
        continue;
      }
    }

    if (this.abortController === controller) this.abortController = null;

    if (finalAssistantText.length > 0) {
      const assistantTurn: OpenAIMessage = {
        role: 'assistant',
        content: finalAssistantText,
      };
      if (finalReasoningText.length > 0) {
        assistantTurn.reasoning_content = finalReasoningText;
      }
      this.priorTurns.push(assistantTurn);
    }

    yield {
      type: 'assistant.message',
      text: finalAssistantText,
      sessionId: this.initSessionId,
    };
    // If the turn was cut short by the tool-round cap, preserve that signal for
    // closure classification (session/closure-reason.ts → `iteration_cap`) and
    // telemetry, even though the wind-down round itself ended naturally.
    yield* this.finishTurn(
      capReached
        ? { ...accumulatedUsage, stopReason: TOOL_USE_LOOP_CAPPED }
        : accumulatedUsage,
      turnStartTime,
    );
  }

  /**
   * Invariant: `runTurn` MUST funnel every non-error exit through here so a
   * single terminal `turn.completed` is emitted for the turn. The persistent
   * stream consumer (agent-session.ts:sendMessageStreamInternal) breaks its
   * `providerIterator.next()` loop only on a terminal output (`turn.completed`
   * → 'done', or `error`). Because the provider's top-level generator loops
   * back to await the next prompt after a turn rather than returning, a
   * `runTurn` exit with no terminal event strands the consumer on a `next()`
   * that never resolves — the permanent "esc to interrupt" hang observed on
   * local OpenAI-shim models that stall or get interrupted mid-stream. Real
   * stream errors are the one exception: their already-yielded `error` event
   * is itself terminal (mirrors anthropic-direct/loop.ts:410-423).
   *
   * `lastUsage` is set here (before the yield) so getContextUsage() reads the
   * correct value even if the outer consumer breaks early — matching the timing
   * in anthropic-direct/query.ts where lastUsage is set on turn.completed.
   */
  private *finishTurn(
    accumulatedUsage: ProviderUsage,
    turnStartTime: number,
  ): Generator<ProviderEvent> {
    this.lastUsage = accumulatedUsage;
    yield {
      type: 'turn.completed',
      usage: { ...accumulatedUsage, durationMs: Date.now() - turnStartTime },
      sessionId: this.initSessionId,
    };
  }

  /**
   * One iteration = one model call + chunk drain. Returns `null` if the
   * stream errored or was aborted (events for those cases already yielded
   * via the catch blocks). Otherwise returns a record describing whether
   * tools need to be dispatched.
   *
   * Note: yields delta events (text/reasoning) as they arrive but does NOT
   * yield `assistant.message` / `turn.completed` — those are the parent
   * `runTurn`'s responsibility once the iteration loop has settled.
   */
  /**
   * Turn an opaque ChatGPT-backend failure into an actionable message. That
   * backend returns 400 for unsupported models, and the OpenAI SDK often
   * surfaces it as "400 status code (no body)". Only rewrites 400s on the
   * ChatGPT backend; every other error passes through unchanged.
   */
  private clarifyResponsesError(err: unknown, isChatGptBackend: boolean): Error {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!isChatGptBackend) return e;
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status?: number }).status
        : undefined;
    if (status !== 400 && !/\b400\b/.test(e.message)) return e;
    let detail: string | undefined;
    const inner = (err as { error?: unknown } | null)?.error;
    if (inner && typeof inner === 'object') {
      const d = inner as { detail?: unknown; message?: unknown };
      if (typeof d.detail === 'string') detail = d.detail;
      else if (typeof d.message === 'string') detail = d.message;
    }
    return new Error(
      `ChatGPT/Codex backend rejected model "${this.currentModel}" (HTTP 400). A ChatGPT ` +
        `subscription only serves certain OpenAI models on this backend (gpt-5.6 and gpt-5.5 ` +
        `work; gpt-5, gpt-5.1, gpt-5.2 and *-codex do not). ` +
        (detail ? `Backend said: ${detail}` : `No error body was returned.`),
    );
  }

  private async *runIteration(
    controller: AbortController,
    vision: boolean,
    windDown = false,
  ): AsyncGenerator<ProviderEvent, IterationResult | null> {
    const messages = buildMessages({
      config: this.opts.config,
      ...(this.opts.config.resumeHistory !== undefined
        ? { resumeHistory: this.opts.config.resumeHistory }
        : {}),
      priorTurns: this.priorTurns,
      vision,
    });

    // Inject plan-mode / AFK-mode posture addendum onto the system message.
    // The two are mutually exclusive permission modes, so at most one applies.
    if (messages[0]?.role === 'system') {
      const addendum =
        this.currentPermissionMode === 'plan' ? PLAN_MODE_ADDENDUM_TEXT :
        this.currentPermissionMode === 'autonomous' ? AFK_MODE_ADDENDUM_TEXT :
        null;
      if (addendum !== null) {
        messages[0] = {
          ...messages[0],
          content: (messages[0].content as string) + '\n\n' + addendum,
        };
      }
    }

    // Wind-down round: strip tools (with none advertised the model MUST answer
    // in text — it cannot emit another tool call) and append the shared budget
    // note to this REQUEST ONLY. `messages` is rebuilt from `priorTurns` each
    // iteration, so the note never persists into stored history. Mirrors
    // anthropic-direct/loop.ts's tools-stripped wind-down; see
    // shared/tool-loop-cap.ts for the shared contract.
    if (windDown) {
      messages.push({ role: 'user', content: WIND_DOWN_NOTE });
    }
    const activeTools = windDown ? undefined : this.activeOpenAITools();

    // Shared context for the retry/stream-drive skeleton (query/stream-drive.ts).
    // Both wire branches build their request body, then hand off to driveStream
    // with a per-wire strategy — the connection/mid-stream retry, once-only
    // model_ttfb emission, and clean-completion return live in one place.
    const driveCtx = {
      controller,
      traceWriter: this.traceWriter,
      initSessionId: this.initSessionId,
      currentModel: this.currentModel,
      isClosed: () => this.closed,
    };

    if (this.wireMode === 'responses') {
      const isChatGptBackend = this.opts.auth.source === 'chatgpt-oauth';

      // The ChatGPT/Codex backend serves only OpenAI gpt-5.x and rejects other
      // model families with an opaque 400 (no body). Subagents/skills commonly
      // request a Claude model (e.g. `sonnet`), and a global AFK_PROVIDER=
      // openai-compatible force-routes it here. Fail fast with an actionable
      // message instead of the bare 400.
      if (isChatGptBackend && isClaudeFamilyModel(this.currentModel)) {
        yield {
          type: 'error',
          error: new Error(
            `Model "${this.currentModel}" can't run on a ChatGPT subscription — the ChatGPT/Codex ` +
              `backend only supports OpenAI gpt-5.x models. This usually means a subagent or skill ` +
              `requested a Claude model. Pass a gpt-5.x model to it (e.g. model: "gpt-5.5"), or run ` +
              `it on a provider configured with the matching API key.`,
          ),
        };
        return null;
      }

      // Responses API path. Request-body assembly (incl. the ChatGPT-backend
      // quirks) lives in query/request-body.ts.
      const requestBody = buildResponsesRequestBody({
        model: this.currentModel,
        messages,
        activeTools,
        maxOutputTokens: this.opts.config.maxOutputTokens,
        effort: this.opts.config.effort,
        isChatGptBackend,
      });

      // Retry / stream-drive is shared with the Chat-Completions branch — see
      // query/stream-drive.ts. Only the four per-wire deltas differ here:
      // client call, event type, translator, and error clarification.
      return yield* driveStream<ResponsesStreamEvent>(driveCtx, {
        createStream: async (signal) =>
          (await this.client.responses.create(requestBody as never, {
            signal,
          })) as unknown as AsyncIterable<ResponsesStreamEvent>,
        translate: (event, state) => translateResponsesEvent(event, state, this.initSessionId),
        clarifyError: (err) => this.clarifyResponsesError(err, isChatGptBackend),
      });
    } else {
      // Chat Completions path. Request-body assembly lives in
      // query/request-body.ts.
      const requestBody = buildChatCompletionsRequestBody({
        model: this.currentModel,
        messages,
        activeTools,
        maxOutputTokens: this.opts.config.maxOutputTokens,
        effort: this.opts.config.effort,
      });

      // Retry / stream-drive is shared with the Responses branch — see
      // query/stream-drive.ts. This wire differs only in the client call, the
      // event type, the translator, and plain Error coercion (no clarify step).
      return yield* driveStream<OpenAIChunk>(driveCtx, {
        createStream: async (signal) =>
          (await this.client.chat.completions.create(requestBody as never, {
            signal,
          })) as unknown as AsyncIterable<OpenAIChunk>,
        translate: (event, state) => translateChunk(event, state, this.initSessionId),
        clarifyError: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
    }
  }

  /**
   * After an iteration produced tool calls: emit `tool.use.start` per call,
   * dispatch through the shared dispatcher, emit outputs, and append the
   * assistant/tool-result messages to running history for the next iteration.
   */
  private async *dispatchAndAppend(
    state: StreamState,
    signal: AbortSignal,
    vision: boolean,
  ): AsyncGenerator<ProviderEvent, ToolResult | undefined> {
    return yield* dispatchAndAppendToolCalls({
      state,
      signal,
      vision,
      toolDispatcher: this.toolDispatcher,
      traceWriter: this.traceWriter,
      priorTurns: this.priorTurns,
      sessionId: this.initSessionId,
      // Owning subagent id (fork only) so tool_call trace events are
      // attributable in the shared parent trace — issue #612. Read from
      // config, the same source this query reads autoCompact/permissionMode.
      subagentId: this.opts.config.subagentId,
    });
  }

  // ---- ProviderQuery surface ------------------------------------------------

  async interrupt(): Promise<void> {
    const c = this.abortController;
    if (c && !c.signal.aborted) {
      c.abort('interrupted');
      return;
    }
    this.pendingAbortReason = 'interrupted';
  }

  /**
   * Summarize older history into a short preamble, in place. Delegates the
   * boundary → summarize → splice sequence (with guardrails) to the shared
   * {@link compactOpenAIHistory} / `runCompactionCore`; the summarization call
   * reuses THIS session's `client`, so it lands on the same endpoint,
   * credentials, and headers as the conversation — a custom-baseURL or local
   * shim session compacts against its own server, never a re-resolved one.
   *
   * The compaction model is `AFK_COMPACT_MODEL` when set (it must be an id this
   * session's endpoint can serve), otherwise the live session model. Cross-
   * provider summarization (e.g. a Claude model summarizing an OpenAI session)
   * is intentionally NOT wired here: a mismatched id simply fails the summarize
   * call, which the core treats as a safe no-op, leaving history untouched.
   *
   * Only Chat Completions sessions are supported. The summarizer runs through
   * `oneShotChatCompletion` (Chat Completions wire), so a responses-mode session
   * (ChatGPT-OAuth, or the `AFK_OPENAI_USE_RESPONSES` opt-in) bails early with
   * `unsupported-wire-mode` rather than issuing a chat.completions call its
   * backend would reject.
   */
  async compact(): Promise<ProviderCompactResult> {
    // Manual entrypoint (REPL /compact, Telegram, router). Auto-compaction
    // calls compactHistory('token_threshold') directly from the turn-boundary
    // check in run(), so the two paths differ only in the emitted trace trigger.
    return this.compactHistory('manual');
  }

  private async compactHistory(
    trigger: CompactionTrigger,
  ): Promise<ProviderCompactResult> {
    const messagesBefore = this.priorTurns.length;
    if (this.opts.auth.apiKey === null) {
      // No usable client was constructed — an auth problem, distinct from a
      // closed session lifecycle. Surface a specific, actionable reason rather
      // than reusing 'session-closed'.
      return { compacted: false, reason: 'no-usable-auth', messagesBefore, messagesAfter: messagesBefore };
    }
    if (this.wireMode === 'responses') {
      // oneShotChatCompletion speaks only Chat Completions; a responses-mode
      // backend (ChatGPT-OAuth / AFK_OPENAI_USE_RESPONSES) would reject that
      // call. Surface an explicit, honest no-op instead of a generic
      // summarization failure so the reason is actionable.
      return {
        compacted: false,
        reason: 'unsupported-wire-mode',
        messagesBefore,
        messagesAfter: messagesBefore,
      };
    }
    const compactModel = env.AFK_COMPACT_MODEL ?? this.currentModel;
    // Token-fullness fallback for the adaptive keep-window (mirrors
    // anthropic-direct/query/compact-handler.ts): measured against the same
    // working budget the auto-compaction trigger uses, so a short-but-full
    // session compacts instead of no-oping on turn count alone.
    const usedFraction = contextFullnessFraction(
      contextWindowTokensUsed(this.lastUsage ?? {}),
      autoCompactLimitFor(this.currentModel),
    );
    return compactOpenAIHistory({
      priorTurns: this.priorTurns,
      usedFraction,
      shrinkAtFraction: readShrinkFraction(),
      summarize: (transcript, signal) =>
        oneShotChatCompletion({
          client: this.client,
          model: compactModel,
          system: COMPACT_SYSTEM_PROMPT,
          user: wrapTranscriptForSummary(transcript),
          maxTokens: 1024,
          signal,
        }),
      isClosed: this.closed,
      isIdle: this.abortController === null,
      beginAbort: () => {
        const controller = new AbortController();
        this.abortController = controller;
        return controller;
      },
      clearAbort: (controller) => {
        if (this.abortController === controller) this.abortController = null;
      },
      trigger,
      traceWriter: this.traceWriter,
    });
  }

  async setModel(model?: string): Promise<void> {
    // Resolve slot/legacy aliases (small/medium/large, custom tier names,
    // haiku/sonnet/opus) to the bound concrete id BEFORE it reaches the request
    // body — mirroring buildQueryFromConfig (the construction path) and
    // anthropic-direct's setModel. Without this, a mid-session same-backend
    // switch to an alias would send the literal alias as the wire model and the
    // backend would reject it. resolveModelId is a no-op for full ids / `auto`.
    if (model !== undefined) this.currentModel = resolveModelId(model) ?? model;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.currentPermissionMode = normalizePermissionMode(mode);
    // Live enforcement, two fields kept in sync (else `/bypass off` fails
    // UNSAFE — badge clears while the agent stays unrestricted):
    //  1. file-tool containment ← dispatcher's allowAll (read fresh per call).
    //     autonomous (AFK) bypasses containment alongside bypassPermissions.
    const allowAll = pathContainmentBypassed(this.currentPermissionMode);
    this.toolDispatcher?.setAllowAll?.(allowAll);
    //  2. path-approval hook ← provider's _currentPermissionMode (callback).
    this.onPermissionMode?.(this.currentPermissionMode);
  }

  setCwd(cwd: string): void {
    this.toolDispatcher?.setResolveBase?.(cwd);
  }

  async supportedCommands(): Promise<ProviderCommandInfo[]> {
    return collectSupportedCommands();
  }

  async supportedModels(): Promise<ProviderModelInfo[]> {
    return [
      {
        value: 'gpt-5.6',
        displayName: 'GPT-5.6 (Sol)',
        description: 'OpenAI flagship — alias for gpt-5.6-sol',
      },
      { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier capability' },
      {
        value: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        description: 'Balanced intelligence/cost',
      },
      {
        value: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        description: 'Fast, high-volume workloads',
      },
      { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Prior flagship (ChatGPT backend)' },
      { value: 'gpt-4o', displayName: 'GPT-4o', description: 'OpenAI flagship multimodal' },
      { value: 'gpt-4o-mini', displayName: 'GPT-4o mini', description: 'Fast/cheap GPT-4o' },
      { value: 'gpt-4.1', displayName: 'GPT-4.1', description: 'Long-context GPT-4' },
      { value: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', description: 'Fast 4.1 variant' },
      { value: 'o1', displayName: 'o1', description: 'Reasoning model' },
      { value: 'o1-mini', displayName: 'o1 mini', description: 'Fast reasoning' },
      { value: 'o3-mini', displayName: 'o3 mini', description: 'Newer reasoning, faster' },
    ];
  }

  async supportedAgents(): Promise<ProviderAgentInfo[]> {
    return [];
  }

  async getContextUsage(): Promise<ProviderContextUsage> {
    // Mirrors anthropic-direct/query.ts:getContextUsage. Reads `this.lastUsage`
    // (set on every turn.completed in runTurn above) and computes a context-%
    // against the model's window via contextLimitFor(). All the ingredients
    // are provider-neutral — `ProviderUsage` is defined at src/agent/provider.ts
    // and `contextLimitFor` lives at src/agent/model-limits.ts.
    //
    // Uses the context-window footprint (`contextWindowTokens`, set per-round in
    // the loop above). For OpenAI that is prompt + completion (= input +
    // output) since `prompt_tokens` already includes cached tokens; falls back
    // to input+output when absent. See auto-compact.ts:contextWindowTokensUsed.
    const last = this.lastUsage;
    const contextLimit = contextLimitFor(this.currentModel);
    let percentage: number | undefined;
    if (last && contextLimit > 0) {
      const used = contextWindowTokensUsed(last);
      percentage = Math.min(100, Math.max(0, (used / contextLimit) * 100));
    }
    // Translate the camelCase ProviderUsage into the snake_case apiUsage +
    // top-level totalTokens the REPL consumers read. See buildContextUsageFields.
    const { totalTokens, apiUsage } = buildContextUsageFields(last);
    return {
      // Context-window usage shape: tools/agents are per-entry token stats AFK does not populate (NOT AgentConfig.agents).
      tools: [],
      agents: [],
      isAutoCompactEnabled: this.autoCompactThreshold !== undefined,
      apiUsage,
      totalTokens,
      ...(percentage !== undefined ? { percentage } : {}),
      maxTokens: contextLimit,
    };
  }

  async mcpServerStatus(): Promise<ProviderMcpServerStatus[]> {
    if (!this.opts.mcpManager) return [];
    return this.opts.mcpManager.getServerStates().map((s) => ({
      name: s.serverName,
      status: s.status,
    }));
  }

  async accountInfo(): Promise<ProviderAccountInfo> {
    return { authSource: this.opts.auth.source };
  }

  async rewindFiles(
    _userMessageId: string,
    _options?: { dryRun?: boolean },
  ): Promise<ProviderRewindResult> {
    return {
      canRewind: false,
      error: `${PROVIDER_NAME} provider does not support file checkpoint rewind yet.`,
    };
  }

  close(): void {
    this.closed = true;
    const c = this.abortController;
    if (c && !c.signal.aborted) {
      c.abort('closed');
    } else {
      this.pendingAbortReason = 'closed';
    }
    this.closeResolve?.();
    debugLog(`🟢 ${PROVIDER_NAME}: closed`);
  }
}

/**
 * Resolve auth + construct a query. Provider entrypoint uses this; tests
 * use the constructor directly via the test-injection hook.
 *
 * The provider that *calls* this is responsible for constructing the
 * `toolDispatcher` (typically a `SessionToolDispatcher`) and threading it
 * through `opts.toolDispatcher`. See `OpenAICompatibleProvider.query()`.
 */
export function buildQueryFromConfig(
  config: AgentConfig,
  promptStream: AsyncIterable<ProviderUserTurn>,
  options: {
    baseURL?: string;
    toolDispatcher?: ToolDispatcher;
    onPermissionMode?: (mode: string) => void;
    mcpManager?: import('../../mcp/index.js').McpManager;
    useResponsesApi?: boolean;
    /**
     * Optional env + fs injection point forwarded to `resolveOpenAIAuth`.
     * Tests pass a hermetic stub here to prevent reading real host credentials
     * (e.g. `~/.codex/auth.json`) from the developer's machine.
     */
    authDeps?: AuthResolverDeps;
  } = {},
): OpenAICompatibleQuery {
  const auth = resolveOpenAIAuth(config.apiKey, options.authDeps, config.forceChatgptOAuth ?? false);
  const synthesizedSessionId =
    config.resume ?? `openai-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Resolve model-slot aliases (small/medium/large, custom names, and the
  // legacy haiku/sonnet/opus aliases) to their bound concrete id BEFORE the id
  // reaches the request body — mirroring anthropic-direct, which already calls
  // resolveModelId internally. Without this, a subagent/skill that picks an
  // alias (e.g. `sonnet`) on this provider would route correctly but still send
  // the literal alias to the backend. Idempotent for concrete ids and `auto`.
  const rawModel = typeof config.model === 'string' ? config.model : 'gpt-4o-mini';
  const model = resolveModelId(rawModel) ?? rawModel;

  const opts: OpenAICompatibleQueryOptions = {
    auth,
    model,
    synthesizedSessionId,
    promptStream,
    config,
  };
  if (options.baseURL !== undefined) opts.baseURL = options.baseURL;
  if (options.toolDispatcher !== undefined) opts.toolDispatcher = options.toolDispatcher;
  if (options.onPermissionMode !== undefined) opts.onPermissionMode = options.onPermissionMode;
  if (options.mcpManager !== undefined) opts.mcpManager = options.mcpManager;
  if (options.useResponsesApi !== undefined) opts.useResponsesApi = options.useResponsesApi;
  // Thread traceWriter from AgentConfig so witness events are emitted for
  // openai-compatible sessions when a session-scoped trace writer is present.
  if (config.traceWriter !== undefined) opts.traceWriter = config.traceWriter;
  return new OpenAICompatibleQuery(opts);
}
