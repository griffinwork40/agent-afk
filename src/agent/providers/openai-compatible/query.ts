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
 *     (or `MAX_TOOL_ITERATIONS` is hit, matching anthropic-direct/loop.ts)
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
import type { EffortLevel } from '../../types/sdk-types.js';
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
import { contextLimitFor, maxOutputTokensFor } from '../../model-limits.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { collectSkillEntries } from '../../tools/skill-bridge.js';
import { extractRawToolInput } from '../../facets/raw-input.js';
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
  accumulatedToolCallsToToolCalls,
  assistantMessageWithToolCalls,
  toolResultsToMessages,
  toolImageFollowupMessage,
  type OpenAIFunctionTool,
} from './loop.js';
import { translateResponsesEvent, type ResponsesStreamEvent } from './responses-translate.js';
import { buildResponsesRequest } from './responses-messages.js';
import { resolveWireMode, envFlagEnabled, isClaudeFamilyModel, DEFAULT_RESPONSES_INSTRUCTIONS, type WireMode } from './responses-config.js';
import { env } from '../../../config/env.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import type { ToolResult } from '../anthropic-direct/types.js';
import { contextWindowTokensUsed, buildContextUsageFields } from '../anthropic-direct/query/auto-compact.js';
import { PLAN_MODE_ADDENDUM_TEXT } from '../anthropic-direct/plan-mode-addendum.js';
import { AFK_MODE_ADDENDUM_TEXT } from '../anthropic-direct/afk-mode-addendum.js';

const PROVIDER_NAME = 'openai-compatible';

/**
 * Hard cap on tool-call iterations within a single user turn. Mirrors
 * `anthropic-direct/loop.ts:MAX_ITERATIONS` (50 there) — a runaway model
 * shouldn't be able to call tools forever. Picked the same value so the
 * two providers behave identically on this edge case.
 */
const MAX_TOOL_ITERATIONS = 50;

// ── Retry / backoff constants ──────────────────────────────────────────────
// Mirrors the Anthropic provider's connection-phase + mid-stream retry pattern
// (see `anthropic-direct/loop.ts:createWithRetry` and the overload-retry block
// in `runTurn`). The Anthropic `RetryLayer` class is too coupled to OAuth /
// keychain hot-swap to share; the core retry pattern (bounded exponential
// backoff on retryable HTTP status codes) is simple enough to implement here
// directly. See issue #126.

/**
 * HTTP status codes that warrant a retry with backoff. 429 (rate limit) and
 * 5xx server errors are transient by nature — the same request sent again
 * after a short wait is likely to succeed. 400/401/403/404 are deterministic
 * client errors and must NOT be retried (they would just burn quota).
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

/** Max connection-phase retries per iteration (matches Anthropic's budget). */
const MAX_CONNECTION_RETRIES = 3;

/** Max mid-stream retries per iteration (matches Anthropic's OVERLOAD_MAX_RETRIES). */
const MAX_STREAM_RETRIES = 3;

/** Base delay for exponential backoff: 2s → 4s → 8s (shorter than Anthropic's 5s because OpenAI-compatible shims are often local). */
let RETRY_BASE_DELAY_MS = 2_000;

/**
 * Test injection hook for retry base delay. Set to 0 in tests to avoid real
 * waits. Pass `null` to restore the production default (2000ms).
 */
export function __setRetryBaseDelay(ms: number | null): void {
  RETRY_BASE_DELAY_MS = ms ?? 2_000;
}

/**
 * Extract an HTTP status code from an error thrown by the OpenAI SDK (or a
 * compatible shim). The SDK throws `APIError` instances with a `status` field;
 * network errors and generic throws have no status and are treated as
 * retryable (transient network blip) only when they carry no explicit code.
 */
function getErrorStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown };
  return typeof e.status === 'number' ? e.status : undefined;
}

/**
 * Connection-phase retryability: the HTTP call itself failed before any
 * streaming began. Only retry on known transient status codes — errors with
 * no status (network drops, DNS failures, wrong baseURL) are deterministic
 * and must surface immediately to avoid wasting time on misconfigurations.
 * Mirrors the Anthropic provider's `isTransientServerError` which also
 * requires an explicit status.
 */
function isRetryableConnectionError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === undefined) return false;
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Mid-stream retryability: the stream was established but the server sent an
 * error event mid-flight. OpenAI-compatible APIs surface this as an `APIError`
 * thrown from the async iterator. Same status-code set as connection-phase —
 * only retry on explicit transient codes, not on status-less errors.
 */
function isRetryableStreamError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === undefined) return false;
  return RETRYABLE_STATUS_CODES.has(status);
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Test injection hook for the OpenAI client. Set to a factory to swap in a
 * mock client; pass `null` to restore the real constructor. Not part of the
 * stable surface — tests reach into this module directly.
 */
export type OpenAIClientFactory = (opts: {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}) => OpenAI;
let clientFactory: OpenAIClientFactory | null = null;
export function __setOpenAIClientFactory(factory: OpenAIClientFactory | null): void {
  clientFactory = factory;
}

/**
 * Resolve the streaming output-token cap for the OpenAI API.
 *
 * Mirrors the o-series field-selection logic in `oneshot.ts:91–96`:
 * o-series reasoning models (o1/o3/o4…) reject `max_tokens` and require
 * `max_completion_tokens`; everything else (chat models, local shims)
 * wants `max_tokens`.  Strips any `provider/` prefix (OpenRouter-style ids)
 * before the regex check so `openai/o3` is treated the same as `o3`.
 *
 * Always returns an object containing the resolved cap; uses the model's
 * output ceiling as a fallback so the field is always present on the wire.
 */
function resolveStreamingMaxTokens(
  model: string,
  configMaxOutput: number | undefined,
): Record<string, number> {
  // Strip any `provider/` prefix (OpenRouter-style ids) before the o-series
  // regex — mirrors oneshot.ts:93.
  const bareModel = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  const isOSeries = /^o[0-9]/.test(bareModel);

  // Resolve the effective cap: honour config.maxOutputTokens when finite+positive,
  // otherwise fall back to the model's output ceiling (matching Anthropic's
  // resolveMaxTokens).  Uses maxOutputTokensFor (output ceiling), not
  // contextLimitFor (context window), because the cap bounds *output*, not
  // the full context window.
  const ceiling = maxOutputTokensFor(model);
  const effectiveMax =
    typeof configMaxOutput === 'number' && Number.isFinite(configMaxOutput) && configMaxOutput > 0
      ? Math.floor(configMaxOutput)
      : ceiling;

  return isOSeries ? { max_completion_tokens: effectiveMax } : { max_tokens: effectiveMax };
}

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
}

function normalizePermissionMode(mode: string | undefined): string {
  return mode ?? 'default';
}

/**
 * Detect OpenAI o-series reasoning models (o1, o3, o4, and their variants).
 * Strips any `provider/` prefix (OpenRouter-style ids) before matching.
 * Mirrors the detection in `oneshot.ts` for the `max_completion_tokens` switch.
 */
export function isOSeriesModel(model: string): boolean {
  const bareModel = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return /^o[0-9]/.test(bareModel);
}

/**
 * Map AFK's `EffortLevel` to OpenAI's `reasoning_effort` values.
 * OpenAI accepts `low`, `medium`, `high`. AFK's `xhigh` and `max` are
 * Anthropic-specific and map to `high` for OpenAI.
 */
export function mapEffortForOpenAI(effort: EffortLevel): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
  }
}

/**
 * Resolve the `reasoning_effort` to send for a given model + effort config.
 * Returns `undefined` when effort should not be forwarded (non-o-series model
 * or no effort configured). Callers attach the result to the request body
 * under `reasoning_effort` (Chat Completions) or `reasoning.effort` (Responses).
 */
export function resolveReasoningEffort(
  effort: EffortLevel | undefined,
  model: string,
): 'low' | 'medium' | 'high' | undefined {
  if (effort === undefined) return undefined;
  if (!isOSeriesModel(model)) return undefined;
  return mapEffortForOpenAI(effort);
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
      const ctor = clientFactory ?? defaultClientFactory;
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

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (controller.signal.aborted) {
        if (this.abortController === controller) this.abortController = null;
        yield* this.finishTurn(accumulatedUsage, turnStartTime);
        return;
      }

      const result = yield* this.runIteration(controller, vision);
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
        // Normal text-only completion — fall through to emit terminal events.
        break;
      }

      // Tool-call path: dispatch, append history, loop.
      yield* this.dispatchAndAppend(result.state, controller.signal, vision);

      {
        const lastToolName = finalizedToolCalls(result.state).at(-1)?.name;
        yield {
          type: 'progress',
          progress: {
            taskId,
            description: 'Tool-use loop',
            summary: `Iteration ${iter + 1}: used ${lastToolName ?? 'unknown'}`,
            lastToolName,
            totalTokens: accumulatedUsage.totalTokens ?? 0,
            toolUses: iter + 1,
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
    yield* this.finishTurn(accumulatedUsage, turnStartTime);
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
        `subscription only serves certain OpenAI models on this backend (gpt-5.5 works; ` +
        `gpt-5, gpt-5.1, gpt-5.2 and *-codex do not). ` +
        (detail ? `Backend said: ${detail}` : `No error body was returned.`),
    );
  }

  private async *runIteration(
    controller: AbortController,
    vision: boolean,
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
      const req = buildResponsesRequest(messages, this.openAITools);
      const requestBody: Record<string, unknown> = {
        model: this.currentModel,
        input: req.input,
        stream: true,
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
              const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
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
        try {
          for await (const event of stream!) {
            if (this.closed) return null;
            for (const ev of translateResponsesEvent(event, state, this.initSessionId)) {
              yield ev;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return null;
          if (isRetryableStreamError(err) && streamRetries < MAX_STREAM_RETRIES) {
            streamRetries++;
            yield { type: 'stream.retry', sessionId: this.initSessionId };
            await sleepWithAbort(
              RETRY_BASE_DELAY_MS * Math.pow(2, streamRetries - 1),
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
      // Only attach `tools` when the dispatcher actually has any — empty
      // arrays make some providers reject the request.
      if (this.openAITools && this.openAITools.length > 0) {
        requestBody['tools'] = this.openAITools;
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
              const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
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
        try {
          for await (const chunk of stream!) {
            if (this.closed) return null;
            for (const ev of translateChunk(chunk, state, this.initSessionId)) {
              yield ev;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return null;
          if (isRetryableStreamError(err) && streamRetries < MAX_STREAM_RETRIES) {
            streamRetries++;
            yield { type: 'stream.retry', sessionId: this.initSessionId };
            await sleepWithAbort(
              RETRY_BASE_DELAY_MS * Math.pow(2, streamRetries - 1),
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
   * dispatch through the shared dispatcher (which runs PreToolUse hooks +
   * permission checks + the actual handler + PostToolUse hooks), then emit
   * `tool.output` per result, then append the assistant{tool_calls} +
   * tool{result} messages to running history for the next iteration.
   */
  private async *dispatchAndAppend(
    state: StreamState,
    signal: AbortSignal,
    vision: boolean,
  ): AsyncGenerator<ProviderEvent> {
    if (!this.toolDispatcher) {
      // Shouldn't reach here — runIteration won't return needsToolDispatch=true
      // when we have no dispatcher because we don't send `tools[]` — but
      // belt-and-braces against a misbehaving model.
      return;
    }

    const accumulated = finalizedToolCalls(state);
    // Invariant: every dispatched tool call MUST carry a non-empty id, and the
    // SAME id must appear on BOTH the assistant turn's `tool_calls[]` and each
    // matching tool-result message's `tool_call_id` — OpenAI rejects a
    // tool_call_id with no corresponding assistant tool_calls[] entry (HTTP
    // 400). Local OpenAI-shim runners (MLX, llama.cpp) sometimes stream
    // tool_calls with an empty or absent id. Mint one synthetic id HERE, once,
    // so both downstream builders observe the same value:
    // accumulatedToolCallsToToolCalls (→ tool-result tool_call_id) and
    // assistantMessageWithToolCalls (→ assistant tool_calls[].id) below.
    // Generating it independently in each builder would desync the pair and
    // reintroduce the 400.
    for (const c of accumulated) {
      if (c.id.length === 0) c.id = randomUUID();
    }
    const { calls, parseErrors } = accumulatedToolCallsToToolCalls(accumulated, signal);

    // Emit tool.use.start BEFORE dispatching, matching anthropic-direct.
    for (const call of calls) {
      yield {
        type: 'tool.use.start',
        toolUseId: call.id,
        toolName: call.name,
        toolInput: summarizeToolInput(call.name, call.input),
        toolInputRaw: extractRawToolInput(call.input),
        sessionId: this.initSessionId,
      };
    }

    // Build results — start with synthetic errors for any JSON parse failures.
    const results: { call: typeof calls[number]; result: ToolResult }[] = [];

    if (signal.aborted) {
      // Aborted before dispatch — synthesize aborted results and emit outputs.
      for (const call of calls) {
        const result: ToolResult = { content: 'Tool call aborted', isError: true };
        results.push({ call, result });
        yield {
          type: 'tool.output',
          toolUseId: call.id,
          toolName: call.name,
          content: result.content,
          isError: true,
          sessionId: this.initSessionId,
        };
      }
    } else {
      // Real dispatch — batch when available, sequential fallback.
      let dispatcherResults: ToolResult[];
      try {
        if (this.toolDispatcher.executeBatch) {
          dispatcherResults = await this.toolDispatcher.executeBatch(calls);
        } else {
          dispatcherResults = [];
          for (const call of calls) {
            if (signal.aborted) {
              dispatcherResults.push({ content: 'Tool call aborted', isError: true });
              continue;
            }
            try {
              dispatcherResults.push(await this.toolDispatcher.execute(call));
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              dispatcherResults.push({
                content: `Tool execution threw: ${message}`,
                isError: true,
              });
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dispatcherResults = calls.map(() => ({
          content: `Tool batch execution failed: ${message}`,
          isError: true,
        }));
      }

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        let result = dispatcherResults[i]!;
        // Layer parse-error diagnostics in front of the dispatcher result —
        // the model needs to know its arguments were malformed.
        const parseErr = parseErrors.get(call.id);
        if (parseErr !== undefined) {
          result = {
            content: `${parseErr}\n--\n${result.content}`,
            isError: true,
            ...(result.truncated === true ? { truncated: true } : {}),
          };
        }
        results.push({ call, result });
        yield {
          type: 'tool.output',
          toolUseId: call.id,
          toolName: call.name,
          content: result.content,
          ...(result.isError === true ? { isError: true } : {}),
          ...(result.truncated === true ? { truncated: true } : {}),
          sessionId: this.initSessionId,
        };
        if (result.render?.diff) {
          yield {
            type: 'tool.diff',
            toolUseId: call.id,
            diff: result.render.diff,
            sessionId: this.initSessionId,
          };
        }
      }
    }

    // Append the assistant turn (with tool_calls) and the tool-result
    // messages to running history so the next iteration's request includes
    // them. OpenAI is strict about this order: assistant{tool_calls} must
    // precede the tool{} messages, and each tool{} must reference a
    // tool_call_id that exists in the assistant turn.
    //
    // `state.reasoningText` is threaded in so DeepSeek-R1-class thinking-mode
    // providers see the reasoning trace echoed back on the assistant turn —
    // omitting it on those providers yields a 400 ("The `reasoning_content`
    // in the thinking mode must be passed back to the API"). Empty text is
    // a no-op for non-thinking providers (the field is omitted entirely).
    this.priorTurns.push(
      assistantMessageWithToolCalls(state.assistantText, accumulated, state.reasoningText) as unknown as OpenAIMessage,
    );
    for (const m of toolResultsToMessages(results)) {
      this.priorTurns.push(m as unknown as OpenAIMessage);
    }
    // Tool-result images (e.g. browser_screenshot) can't ride the `role:'tool'`
    // message (OpenAI carries only text there). On vision-capable models they
    // surface as a follow-up `role:'user'` image message pushed AFTER the tool
    // messages so the alternation stays valid. Undefined (no push) when the
    // model lacks vision or no result carried an image. See issue #127.
    const imageFollowup = toolImageFollowupMessage(results, { vision });
    if (imageFollowup) this.priorTurns.push(imageFollowup);
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
    if (model !== undefined) this.currentModel = model;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.currentPermissionMode = normalizePermissionMode(mode);
    // Live enforcement, two fields kept in sync (else `/bypass off` fails
    // UNSAFE — badge clears while the agent stays unrestricted):
    //  1. file-tool containment ← dispatcher's allowAll (read fresh per call).
    const bypass = this.currentPermissionMode === 'bypassPermissions';
    this.toolDispatcher?.setAllowAll?.(bypass);
    //  2. path-approval hook ← provider's _currentPermissionMode (callback).
    this.onPermissionMode?.(this.currentPermissionMode);
  }

  setCwd(cwd: string): void {
    this.toolDispatcher?.setResolveBase?.(cwd);
  }

  async supportedCommands(): Promise<ProviderCommandInfo[]> {
    // Mirrors anthropic-direct/query.ts:supportedCommands — surfaces every
    // skill discovered by skill-bridge (built-in TS skills, ~/.afk/skills/,
    // and plugin SKILL.md files) so the REPL slash registry can register a
    // passthrough /<skill> for each one. Without this, /reload-plugins
    // reports 0 skills on OpenAI sessions and typing /mint does not
    // autocomplete. collectSkillEntries() is provider-agnostic (no model
    // SDK imports) so the body lifts unchanged.
    //
    // Extract to a shared helper module when a third provider lands.
    try {
      const entries = collectSkillEntries();
      return entries.map((e) => {
        const info: ProviderCommandInfo = {
          name: e.name,
          description: e.description,
        };
        if (e.argumentHint) info.argumentHint = e.argumentHint;
        return info;
      });
    } catch {
      // Discovery is best-effort — the REPL stays usable without it.
      return [];
    }
  }

  async supportedModels(): Promise<ProviderModelInfo[]> {
    return [
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

function defaultClientFactory(opts: {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}): OpenAI {
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: opts.apiKey };
  if (opts.baseURL !== undefined) clientOpts.baseURL = opts.baseURL;
  if (opts.defaultHeaders !== undefined) clientOpts.defaultHeaders = opts.defaultHeaders;
  return new OpenAI(clientOpts);
}

/**
 * Best-effort one-line summary of a tool input. Mirrors the same-named
 * helper in anthropic-direct/loop.ts so `tool.use.start` events render
 * identically across providers.
 */
function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // Skill dispatch: the `name` field IS the skill being invoked (diagnose,
  // review, mint, …). Surface it as a paren-wrapped label so the tool lane
  // renders `skill(diagnose)` instead of a bare `skill [skill]`. Mirrors the
  // anthropic-direct helper exactly so labels render identically across
  // providers — see the rationale comment in anthropic-direct/loop.ts.
  if (toolName === 'skill' || toolName === 'Skill') {
    const skillName = obj['name'];
    if (typeof skillName === 'string' && skillName.length > 0) {
      return `(${skillName.length > 60 ? skillName.slice(0, 59) + '…' : skillName})`;
    }
    return '';
  }
  const path = obj['file_path'] ?? obj['path'] ?? obj['filePath'];
  if (typeof path === 'string') return ' ' + path;
  const cmd = obj['command'] ?? obj['cmd'];
  if (typeof cmd === 'string') {
    const firstLine = cmd.split('\n')[0]!;
    return ' ' + (firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine);
  }
  const query = obj['query'] ?? obj['pattern'] ?? obj['url'] ?? obj['description'];
  if (typeof query === 'string') return ' ' + query;
  return '';
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
  return new OpenAICompatibleQuery(opts);
}
