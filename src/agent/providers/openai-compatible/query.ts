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
 * Things deliberately deferred:
 *   - File checkpointing / rewindFiles (deferred — `canRewind: false`)
 *   - Compact (provider opts out by leaving `compact` undefined)
 *
 * @module agent/providers/openai-compatible/query
 */

import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../../types/config-types.js';
import { emitSessionPhase } from '../../trace/emit.js';
import { pathContainmentBypassed } from '../../permission-policy.js';
import type { TraceWriter } from '../../trace/index.js';
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
} from '../../provider.js';
import { sumProviderUsage } from '../../usage.js';
import { contextLimitFor } from '../../model-limits.js';
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
  createStreamState,
  translateChunk,
  usageFromState,
  finalizedToolCalls,
  isToolCallStop,
  type OpenAIChunk,
  type StreamState,
} from './translate.js';
import {
  toolDefsToOpenAIFunctions,
  type OpenAIFunctionTool,
} from './loop.js';
import { translateResponsesEvent, type ResponsesStreamEvent } from './responses-translate.js';
import { buildResponsesRequest } from './responses-messages.js';
import { resolveWireMode, envFlagEnabled, isClaudeFamilyModel, DEFAULT_RESPONSES_INSTRUCTIONS, type WireMode } from './responses-config.js';
import { env } from '../../../config/env.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import { contextWindowTokensUsed, buildContextUsageFields } from '../shared/auto-compact.js';
import { PLAN_MODE_ADDENDUM_TEXT } from '../shared/plan-mode-addendum.js';
import { AFK_MODE_ADDENDUM_TEXT } from '../shared/afk-mode-addendum.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/handlers/exit-plan-mode.js';
import { sleepWithAbort } from '../shared/sleep-with-abort.js';
import { summarizeToolInput } from '../shared/tool-input-summary.js';
import { dispatchAndAppendToolCalls } from './query/dispatch-append.js';
import {
  TOOL_USE_LOOP_CAPPED,
  WIND_DOWN_NOTE,
  resolveMaxToolIterations,
  shouldWindDown,
} from '../shared/tool-loop-cap.js';
import {
  MAX_CONNECTION_RETRIES,
  MAX_STREAM_RETRIES,
  isRetryableConnectionError,
  isRetryableStreamError,
  computeBackoffDelay,
} from './query/retry.js';
import {
  resolveEffectiveMaxOutputTokens,
  resolveStreamingMaxTokens,
  normalizePermissionMode,
  resolveReasoningEffort,
} from './query/model-params.js';
import { resolveClientFactory } from './query/client.js';

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
interface IterationResult {
  state: StreamState;
  events: ProviderEvent[];
  /** Final assistant text accumulated this iteration. */
  text: string;
  /** True when this iteration ended in tool_calls (we need to dispatch and loop). */
  needsToolDispatch: boolean;
}

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

  constructor(opts: OpenAICompatibleQueryOptions) {
    this.opts = opts;
    this.initSessionId = opts.synthesizedSessionId;
    this.currentModel = opts.model;
    this.currentPermissionMode = normalizePermissionMode(opts.config.permissionMode);
    this.toolDispatcher = opts.toolDispatcher;
    this.onPermissionMode = opts.onPermissionMode;
    this.traceWriter = opts.traceWriter;

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

    // Witness layer: mark loop entry. Mirrors anthropic-direct/loop.ts:229.
    // Fire-and-forget — a broken trace writer must never stall the turn.
    void emitSessionPhase(this.traceWriter, { phase: 'loop_start' });
    try {
    yield* this._runTurnInner(content, controller, turnStartTime, taskId);
    } finally {
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
      yield* this.dispatchAndAppend(result.state, controller.signal, vision);
      round += 1;

      {
        const lastCall = finalizedToolCalls(result.state).at(-1);
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
            toolUses: round,
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

      // Responses API path. `messages` (built + plan-mode-adjusted above) is
      // converted to the Responses input shape; the system prompt becomes
      // `instructions`, tool calls/results become function_call/_output items.
      const req = buildResponsesRequest(messages, activeTools);
      const requestBody: Record<string, unknown> = {
        model: this.currentModel,
        input: req.input,
        stream: true,
      };
      // Output-token cap. The Responses API uses `max_output_tokens` — NOT Chat
      // Completions' `max_tokens`/`max_completion_tokens`. The private ChatGPT/
      // Codex subscription backend rejects *every* output-cap parameter with an
      // opaque HTTP 400 (`{"detail":"Unsupported parameter: max_tokens"}`, and
      // likewise for `max_output_tokens`), so omit the cap there entirely and
      // let the backend apply its own limit. (Sending `max_tokens` here is what
      // made every ChatGPT-subscription request fail.)
      if (!isChatGptBackend) {
        requestBody['max_output_tokens'] = resolveEffectiveMaxOutputTokens(
          this.currentModel,
          this.opts.config.maxOutputTokens,
        );
      }
      // The private ChatGPT backend (subscription path) has two hard
      // requirements the public Responses API does not: a non-empty
      // `instructions`, and `store: false`. Scope both to that path so the
      // public API-key path keeps its defaults.
      const instructions =
        req.instructions ?? (isChatGptBackend ? DEFAULT_RESPONSES_INSTRUCTIONS : undefined);
      if (instructions !== undefined) requestBody['instructions'] = instructions;
      if (isChatGptBackend) requestBody['store'] = false;
      if (req.tools && req.tools.length > 0) requestBody['tools'] = req.tools;
      // Forward reasoning effort for o-series models on the Responses API.
      // Uses the `reasoning: { effort }` shape per OpenAI's Responses API spec.
      const responsesEffort = resolveReasoningEffort(this.opts.config.effort, this.currentModel);
      if (responsesEffort !== undefined) {
        requestBody['reasoning'] = { effort: responsesEffort };
      }

      // Retry loop: connection-phase + mid-stream retry with exponential
      // backoff. Mirrors the Anthropic provider's createWithRetry + overload
      // retry pattern (see `anthropic-direct/loop.ts`). State is reset on each
      // retry so the re-driven request starts from a clean slate.
      let streamRetries = 0;
      for (;;) {
        const state = createStreamState();

        // Witness layer: stamp request-initiation time for model_ttfb below.
        const requestStartedAt = Date.now();

        // ── Connection-phase retry ──────────────────────────────────────
        let stream: AsyncIterable<ResponsesStreamEvent>;
        let connectionError: unknown = null;
        for (let attempt = 0; ; attempt++) {
          try {
            stream = (await this.client.responses.create(requestBody as never, {
              signal: controller.signal,
            })) as unknown as AsyncIterable<ResponsesStreamEvent>;
            break; // connection succeeded
          } catch (err) {
            if (controller.signal.aborted) return null;
            if (isRetryableConnectionError(err) && attempt < MAX_CONNECTION_RETRIES) {
              const delay = computeBackoffDelay(attempt);
              await sleepWithAbort(delay, controller.signal);
              if (controller.signal.aborted) return null;
              continue;
            }
            connectionError = err;
            break;
          }
        }

        if (connectionError !== null) {
          yield { type: 'error', error: this.clarifyResponsesError(connectionError, isChatGptBackend) };
          return null;
        }

        // ── Mid-stream consumption with retry ───────────────────────────
        let streamError: unknown = null;
        // Witness layer: emit model_ttfb exactly once per API call, on the
        // first translated stream event. Reset per for(;;) iteration so each
        // retry-driven call reports its own time-to-first-byte. Mirrors
        // anthropic-direct/loop.ts:307–327.
        let ttfbEmitted = false;
        try {
          for await (const event of stream!) {
            if (this.closed) return null;
            for (const ev of translateResponsesEvent(event, state, this.initSessionId)) {
              if (!ttfbEmitted) {
                ttfbEmitted = true;
                void emitSessionPhase(this.traceWriter, {
                  phase: 'model_ttfb',
                  durationMs: Date.now() - requestStartedAt,
                  resolvedModel: this.currentModel,
                });
              }
              yield ev;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return null;
          if (isRetryableStreamError(err) && streamRetries < MAX_STREAM_RETRIES) {
            streamRetries++;
            yield { type: 'stream.retry', sessionId: this.initSessionId };
            await sleepWithAbort(
              computeBackoffDelay(streamRetries - 1),
              controller.signal,
            );
            if (controller.signal.aborted) return null;
            continue; // retry the whole iteration
          }
          streamError = err;
        }

        if (streamError !== null) {
          yield { type: 'error', error: this.clarifyResponsesError(streamError, isChatGptBackend) };
          return null;
        }

        // Clean completion — return the result.
        return {
          state,
          events: [],
          text: state.assistantText,
          needsToolDispatch: isToolCallStop(state) && state.toolCallsByIndex.size > 0,
        };
      }
    } else {
      const requestBody: Record<string, unknown> = {
        model: this.currentModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      // Thread the output-token cap into the streaming request so callers can
      // bound output length (parity with Anthropic's always-forwarded
      // max_tokens).  Reuses the o-series field-selection logic from
      // oneshot.ts:91–96.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      Object.assign(requestBody, resolveStreamingMaxTokens(
        this.currentModel,
        this.opts.config.maxOutputTokens,
      ));
      // Only attach `tools` when there are any to advertise THIS turn — empty
      // arrays make some providers reject the request. `activeOpenAITools()`
      // drops the plan-exit tool on non-plan turns (resident-but-gated); on a
      // wind-down round `activeTools` is undefined (tools stripped, see above).
      if (activeTools && activeTools.length > 0) {
        requestBody['tools'] = activeTools;
      }
      // Forward reasoning effort for o-series models on Chat Completions.
      // Uses the `reasoning_effort` field per OpenAI's Chat Completions API spec.
      const chatEffort = resolveReasoningEffort(this.opts.config.effort, this.currentModel);
      if (chatEffort !== undefined) {
        requestBody['reasoning_effort'] = chatEffort;
      }

      // Retry loop: connection-phase + mid-stream retry with exponential
      // backoff. Same pattern as the Responses path above.
      let streamRetries = 0;
      for (;;) {
        const state = createStreamState();

        // Witness layer: stamp request-initiation time for model_ttfb below.
        const requestStartedAt = Date.now();

        // ── Connection-phase retry ──────────────────────────────────────
        let stream: AsyncIterable<OpenAIChunk>;
        let connectionError: unknown = null;
        for (let attempt = 0; ; attempt++) {
          try {
            stream = (await this.client.chat.completions.create(requestBody as never, {
              signal: controller.signal,
            })) as unknown as AsyncIterable<OpenAIChunk>;
            break; // connection succeeded
          } catch (err) {
            if (controller.signal.aborted) return null;
            if (isRetryableConnectionError(err) && attempt < MAX_CONNECTION_RETRIES) {
              const delay = computeBackoffDelay(attempt);
              await sleepWithAbort(delay, controller.signal);
              if (controller.signal.aborted) return null;
              continue;
            }
            connectionError = err;
            break;
          }
        }

        if (connectionError !== null) {
          const e = connectionError instanceof Error ? connectionError : new Error(String(connectionError));
          yield { type: 'error', error: e };
          return null;
        }

        // ── Mid-stream consumption with retry ───────────────────────────
        let streamError: unknown = null;
        // Witness layer: emit model_ttfb exactly once per API call, on the
        // first translated stream event. Reset per for(;;) iteration so each
        // retry-driven call reports its own time-to-first-byte. Mirrors
        // anthropic-direct/loop.ts:307–327.
        let ttfbEmitted = false;
        try {
          for await (const chunk of stream!) {
            if (this.closed) return null;
            for (const ev of translateChunk(chunk, state, this.initSessionId)) {
              if (!ttfbEmitted) {
                ttfbEmitted = true;
                void emitSessionPhase(this.traceWriter, {
                  phase: 'model_ttfb',
                  durationMs: Date.now() - requestStartedAt,
                  resolvedModel: this.currentModel,
                });
              }
              yield ev;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return null;
          if (isRetryableStreamError(err) && streamRetries < MAX_STREAM_RETRIES) {
            streamRetries++;
            yield { type: 'stream.retry', sessionId: this.initSessionId };
            await sleepWithAbort(
              computeBackoffDelay(streamRetries - 1),
              controller.signal,
            );
            if (controller.signal.aborted) return null;
            continue; // retry the whole iteration
          }
          streamError = err;
        }

        if (streamError !== null) {
          const e = streamError instanceof Error ? streamError : new Error(String(streamError));
          yield { type: 'error', error: e };
          return null;
        }

        // Clean completion — return the result.
        return {
          state,
          events: [],
          text: state.assistantText,
          needsToolDispatch: isToolCallStop(state) && state.toolCallsByIndex.size > 0,
        };
      }
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
  ): AsyncGenerator<ProviderEvent> {
    yield* dispatchAndAppendToolCalls({
      state,
      signal,
      vision,
      toolDispatcher: this.toolDispatcher,
      traceWriter: this.traceWriter,
      priorTurns: this.priorTurns,
      sessionId: this.initSessionId,
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
      isAutoCompactEnabled: false,
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
  const auth = resolveOpenAIAuth(config.apiKey, options.authDeps);
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
