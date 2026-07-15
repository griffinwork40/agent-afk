/**
 * Provider-backed session wrapper.
 *
 * `AgentSession` is the harness's single runtime entry point; the underlying
 * backend (Anthropic Claude Agent SDK, OpenAI Codex SDK) is chosen by model
 * family via `providerForModel()` unless the caller injects a custom
 * `ModelProvider` on `AgentConfig.provider`. Everything downstream of the
 * provider's async-iterable lane speaks the harness-native `ProviderEvent`
 * dialect, so this class never imports from any model SDK.
 *
 * @module agent/session/agent-session
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { debugLog } from '../../utils/debug.js';
import { AbortError } from '../../utils/errors.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { HookRegistry } from '../hooks.js';
import { resolveProvider, providerForModel } from '../providers/index.js';
import { ProviderRouter } from '../providers/router/provider-router.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import type { ProviderCompactResult, ProviderEvent, ProviderQuery } from '../provider.js';
import { DEFAULT_SESSION_TIMEOUT_MS, RESET_DRAIN_TIMEOUT_MS, withTimeout } from '../timeout.js';
import { dispatchSessionEnd, dispatchSessionStart } from './hooks-dispatch.js';
import { HookBlockedError } from '../../utils/errors.js';
import {
  emitClosureEvent,
  sealTraceWriter,
  type ClosureSignals,
} from './closure-emitter.js';
import { extractStructuredOutput } from '../output-extractor.js';
import { z, type ZodType } from 'zod';
import type {
  AccountInfo,
  AgentConfig,
  AgentInfo,
  AgentModelInput,
  IAgentSession,
  InputStreamRef,
  McpServerStatus,
  Message,
  ModelInfo,
  OutputEvent,
  PermissionMode,
  ResponseMetadata,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SendMessageOptions,
  SessionIdentity,
  SessionMetadata,
  SessionState,
  SlashCommand,
  StructuredMessageOptions,
} from '../types.js';
import { QueryInputStream } from './input-iterable.js';
import { LedgerLifecycle } from './ledger-lifecycle.js';
import { PlanExitBridge } from './plan-exit-bridge.js';
import type { ElicitationRequest } from '../types/sdk-types.js';
import { resolveModelId } from './model-resolution.js';
import { deriveOrigin, deriveActor } from './session-identity.js';
import { updatePresenceCwd } from '../awareness/presence.js';
import { setSlotBindings } from './model-slots.js';
import { applySlotCredentials } from './slot-credentials.js';
import {
  buildInitialState,
  wireAbortSignal,
} from './session-setup.js';
import { SessionStateManager } from './session-state.js';
import { transformProviderEvent, type TransformDeps } from './stream-consumer.js';
import { getSessionGrantsPath } from '../../paths.js';
import {
  capJsonlBySize,
  SESSION_GRANTS_MAX_BYTES,
  SESSION_GRANTS_KEEP_TAIL_LINES,
} from '../log-retention.js';


export class AgentSession implements IAgentSession {
  private config: AgentConfig;
  /**
   * Plan-mode-exit state machine: the pending implement-turn seed, the captured
   * pre-plan mode to restore, and the transient Shift+Tab ring-gesture memory.
   * Lives on the session (not the per-turn dispatcher) so it survives from a
   * mid-turn `exit_plan_mode` tool call to the post-turn REPL boundary. See
   * {@link PlanExitBridge} for the ring-gesture rescue invariants.
   */
  private readonly planExit = new PlanExitBridge();
  private currentState: SessionState = 'idle';
  private providerQuery!: ProviderQuery;
  private providerIterator!: AsyncIterator<ProviderEvent>;
  private conversationHistory: Message[] = [];
  private turnCount = 0;
  /**
   * Hook-generated context (e.g. SubagentStop `injectContext`) waiting to be
   * prepended to the next outbound user message. Never delivered as its own
   * input-stream message — see `queueFrameworkContext`.
   */
  private pendingFrameworkContext: string[] = [];
  private lastResponseMetadata: ResponseMetadata | null = null;
  private initPromise: Promise<void> | null = null;
  private inputStream!: QueryInputStream;
  private readonly abortController: AbortController;
  private readonly _hookRegistry: HookRegistry | undefined;
  private sessionEndDispatched = false;
  private stateManager!: SessionStateManager;
  /** Cumulative USD cost across all turns this session. Mirrored from
   *  per-turn `metadata.totalCostUsd` so the trace writer's
   *  `session_sealed` payload can report the final figure without
   *  reaching into `TransformDeps`. */
  private sessionRunningCostUsd = 0;
  /** Cumulative token counters across all turns. Mirrored from each
   *  turn's `metadata.usage` so the `closure` event can report the final
   *  tuple. Per-counter optionality on the schema lets us emit a partial
   *  tuple when a provider doesn't report cache breakdowns. */
  private sessionRunningTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  } = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  /** Last `stopReason` the provider reported on a `turn.completed` event.
   *  Threaded into the `closure` trace payload so a reader can see what
   *  the model said about the end of the final turn (e.g. `end_turn`,
   *  `tool_use_loop_capped`, `max_tokens`). Undefined when no turn
   *  completed in this session. */
  private lastStopReason: string | undefined;
  /**
   * Terminal-cause flags set at their origin sites so `deriveClosureReason`
   * reports the specific reason instead of a generic abort. Reset by `reset()`.
   */
  private maxTurnsHit = false;
  private hookBlocked = false;
  /**
   * True when the provider emitted a terminal `error` event (an HTTP / auth /
   * stream failure) as the session's last turn outcome. Set at the two
   * error-observation sites — `pullInitialization` (init-phase error) and
   * `sendMessageStreamInternal` (per-turn error) — and cleared by a subsequent
   * completed turn so it reflects the FINAL turn's result, not any error
   * earlier in the session. Read by `deriveClosureReason` (→ `abort`) and
   * `deriveSealStatus` (→ `failed`) so a provider failure on an otherwise-clean
   * `close()` is not sealed as a silent `succeeded` / `model_end_turn`. Reset
   * by `reset()`.
   */
  private sawProviderError = false;
  /**
   * Wall-clock timestamp captured at construction — used to compute the
   * `session_init_done` phase duration and the `session_init_start` emit.
   */
  private readonly sessionStartedAt: number = Date.now();
  /** Number of subagent forks that reached `succeeded` status. */
  private subagentCompletedCount = 0;
  /** Cumulative token counters rolled up from completed subagents. */
  private subagentRunningTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  } = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  /** Cumulative USD cost rolled up from completed subagents. */
  private subagentRunningCostUsd = 0;
  /**
   * Durable per-session event ledger (`~/.afk/state/sessions/<id>/events.jsonl`).
   * Created lazily on the first turn once the provider has issued a session id.
   * Top-level sessions only — subagents are observable via the bg-job log and
   * witness traces; mirroring them here would multiply files per session.
   * Inert (no writer) when disabled (env opt-out), gated off (subagent), or
   * after close. Lifecycle glue lives in {@link LedgerLifecycle}.
   */
  private readonly ledger = new LedgerLifecycle();

  constructor(config: AgentConfig) {
    // Wire the plan-exit control bridge for top-level sessions only (plan mode
    // is a REPL affordance; subagent/forked sessions carry a parentSessionId).
    // The model-callable `exit_plan_mode` tool uses these callbacks to flip the
    // live permission mode and queue the implement-turn the REPL drains. Inert
    // unless the session actually enters plan mode (the providers only register
    // the tool then). Respect a caller-supplied bridge if one is already set.
    this.config =
      config.parentSessionId === undefined && config.planExitControls === undefined
        ? {
            ...config,
            planExitControls: {
              setPermissionMode: (mode) => this.setPermissionMode(mode),
              requestImplementSeed: (message, mode) =>
                this.planExit.requestImplementSeed(message, mode),
              getPrePlanMode: () => this.planExit.getPrePlanMode(),
            },
          }
        : config;
    this.abortController = new AbortController();
    this._hookRegistry = config.hookRegistry;

    wireAbortSignal(config.abortSignal, this.abortController, () => {
      void this.onAbort();
    });

    // Witness layer: mark the start of provider/SDK initialization so
    // downstream tooling can compute the session_init phase duration. This is
    // ALSO the root session's model-provenance anchor: emitted unconditionally
    // here in the constructor (earliest event, provider-agnostic) so every
    // trace names its root model even with zero subagents and zero completed
    // API calls. `model` = operator-typed alias; `resolvedModel` = wire id.
    const configuredModel = String(config.model);
    void emitSessionPhase(config.traceWriter, {
      phase: 'session_init_start',
      model: configuredModel,
      resolvedModel: resolveModelId(config.model) ?? configuredModel,
      // Session-identity attribution anchor: origin (user-facing surface) +
      // actor (main vs subagent) so trace-only analysis answers both questions.
      origin: deriveOrigin(config.surface),
      actor: deriveActor(config.parentSessionId),
    });

    this.initSdkLifecycle();

    // Bound the write-only session-grants audit log at session start. Top-level
    // sessions only: subagents share the parent's path, so re-running per fork
    // is redundant and widens the rewrite-collision window. Fire-and-forget +
    // silent-fail — best-effort housekeeping that must never delay or break
    // construction. Runs at bootstrap rather than inline at the (concurrent)
    // append sites; see src/agent/log-retention.ts for why.
    if (this.config.parentSessionId === undefined) {
      void capJsonlBySize(getSessionGrantsPath(), {
        maxBytes: SESSION_GRANTS_MAX_BYTES,
        keepTailLines: SESSION_GRANTS_KEEP_TAIL_LINES,
      });
    }
  }

  /**
   * Build (or rebuild) the SDK-side plumbing: provider query, input stream,
   * state manager, and the provider iterator. Pulls `session.init` eagerly
   * so `waitForInitialization` resolves without a user turn.
   *
   * The internal `abortController` and `hookRegistry` are NOT touched — they
   * live for the entire session-object lifetime so that an externally-supplied
   * `config.abortSignal` keeps propagating across resets and registered
   * SessionStart/SessionEnd hooks fire on each cycle.
   */
  private initSdkLifecycle(): void {
    // Safety net for direct construction (library/test) that bypasses
    // `loadConfig()`: install any caller-provided slot bindings process-globally
    // so `resolveModelId`/`resolveProvider` below resolve tier aliases. The CLI
    // path already installed them in `loadConfig`; this is idempotent.
    if (this.config.models) setSlotBindings(this.config.models);

    // Stage 2: apply the resolved model's per-slot provider credentials
    // (provider/baseUrl/apiKey) onto this session's config so the active
    // provider reads them at query time. No-op unless the model resolves to a
    // slot carrying explicit credentials.
    applySlotCredentials(this.config);

    const resolvedModel = resolveModelId(this.config.model) ?? (this.config.model as string);
    const { sessionIdentity, metadata } = buildInitialState(this.config, resolvedModel);

    this.stateManager = new SessionStateManager(sessionIdentity, metadata);
    this.inputStream = new QueryInputStream(() => this.sessionId);

    // Provider selection.
    //   - Caller-injected provider (`config.provider`): use it directly,
    //     unchanged. Telegram/daemon inject a configured provider this way.
    //   - Otherwise: install a ProviderRouter that routes EACH turn to the
    //     provider for the currently-selected model, so `/model` can cross
    //     provider families in one session without a global AFK_PROVIDER. The
    //     swap happens below this session, so the accumulators and
    //     SessionStart/SessionEnd hooks reset here are untouched by a model
    //     switch. Routing still honors AFK_PROVIDER when set (it resolves to a
    //     single family, so the router never swaps) — it is now an optional
    //     escape hatch, not a requirement.
    const promptIterable = this.inputStream.createIterable();
    if (this.config.provider) {
      debugLog(`🟢 AgentSession: Creating query session via injected provider=${this.config.provider.name}`);
      this.providerQuery = this.config.provider.query({ prompt: promptIterable, config: this.config });
    } else {
      debugLog(`🟢 AgentSession: Creating query session via ProviderRouter`);
      // When config.providerFactory is set, use it as resolveProvider so every
      // provider built during a cross-family /model swap is fully wired (with
      // subagentExecutor, skillExecutor, composeExecutor, memoryStore, mcpManager,
      // and permission lists). When absent, fall back to the bare resolveProvider
      // which is suitable for one-shot and test paths that need no executors.
      // Thread customTools through the fallback so library query() callers get
      // their tools even without a full providerFactory.
      const resolveProviderFn = this.config.providerFactory
        ? this.config.providerFactory
        : (m: string | undefined) =>
            resolveProvider(m, undefined, {
              customTools: this.config.customTools,
              canUseTool: this.config.canUseTool,
            });
      this.providerQuery = new ProviderRouter(
        { prompt: promptIterable, config: this.config },
        {
          resolveProvider: resolveProviderFn,
          providerNameForModel: (m) => providerForModel(m),
          resolveApiKey: (m) => resolveCredentialForModel(m),
        },
      );
    }

    this.conversationHistory = [];
    this.turnCount = 0;
    this.lastResponseMetadata = null;
    this.sessionRunningCostUsd = 0;
    this.sessionRunningTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    this.lastStopReason = undefined;
    this.maxTurnsHit = false;
    this.hookBlocked = false;
    this.sawProviderError = false;
    this.sessionEndDispatched = false;
    this.currentState = 'idle';
    this.subagentCompletedCount = 0;
    this.subagentRunningTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    this.subagentRunningCostUsd = 0;
    this.pendingFrameworkContext = [];

    const iterable = this.providerQuery as AsyncIterable<ProviderEvent>;
    this.providerIterator = iterable[Symbol.asyncIterator]();

    this.initPromise = this.pullInitialization();
  }

  /**
   * Pull events from the provider iterator until `session.init` arrives.
   * Dispatches the SessionStart hook first (may block init).
   */
  private async pullInitialization(): Promise<void> {
    try {
      const sessionStartInjectContext = await dispatchSessionStart(
        this._hookRegistry,
        {
          event: 'SessionStart',
          sessionId: this.sessionId,
          parentSessionId: this.config.parentSessionId,
        },
        {
          signal: this.abortController.signal,
          ...(this.config.traceWriter ? { traceWriter: this.config.traceWriter } : {}),
        },
      );
      // Invariant: queue SessionStart injectContext HERE — before the init loop
      // below resolves initPromise. `sendMessageStreamInternal` awaits
      // initPromise before draining the queue via `withPendingFrameworkContext`,
      // so this queued context is guaranteed to ride the session's FIRST
      // outbound user message. Queued (not pushed) to avoid the one-turn
      // displacement documented on `queueFrameworkContext`.
      //
      // Parent-only: subagent forks run this same init path with the bubbled
      // hook registry (see subagent.ts), so an unconditional queue would prepend
      // session-priming context to EVERY subagent's first prompt — token cost
      // multiplied across a fan-out, plus contamination of narrowly-scoped
      // subagent tasks. Gate on the top-level predicate used elsewhere in this
      // file (parentSessionId undefined; see the ledger/actor checks above) so
      // only the parent session delivers it. This mirrors the self-skip
      // convention SessionEnd already documents and Claude Code's own behavior
      // (SessionStart is a per-session, not per-subagent, injection point).
      if (sessionStartInjectContext && this.config.parentSessionId === undefined) {
        this.queueFrameworkContext(sessionStartInjectContext);
      }

      while (true) {
        const result = await this.providerIterator.next();
        if (result.done) {
          this.stateManager.resolveInitializationIfNeeded();
          return;
        }
        const event = result.value;
        const output = transformProviderEvent(event, this.buildTransformDeps());
        if (event.type === 'session.init') {
          // Witness layer: mark end of init phase with wall-clock duration.
          // MUST be awaited: initPromise resolves inside transformProviderEvent
          // (line above) so any code awaiting initPromise — including
          // sendMessageStreamInternal — is already runnable at this point.
          // A void/fire-and-forget call here yields a microtask gap in which
          // sendMessageStreamInternal can advance the shared providerIterator
          // before pullInitialization() returns, causing two concurrent
          // consumers on the same iterator and silently swallowing the first
          // user message's response. Awaiting ensures we exit cleanly first.
          await emitSessionPhase(this.config.traceWriter, {
            phase: 'session_init_done',
            durationMs: Date.now() - this.sessionStartedAt,
          });
          return;
        }
        if (output && output.type === 'error') {
          // Terminal-cause flag: an init-phase provider error must not seal as
          // a clean close. The eventual close()/reset() reads this so the trace
          // reports `abort`/`failed` rather than a silent `model_end_turn`.
          this.sawProviderError = true;
          return;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Origin signal for `hook_blocked`: a SessionStart hook that blocks
      // throws HookBlockedError up through pullInitialization() to here.
      if (error instanceof HookBlockedError) {
        this.hookBlocked = true;
      }
      if (!this.stateManager.isInitializationSettled()) {
        this.stateManager.rejectInitializationOnce(error);
      }
      await this.dispatchSessionEndOnce('error').catch(() => {});
    }
  }

  private buildTransformDeps(): TransformDeps {
    return {
      // Fresh per-turn accumulator for successful tool names (see
      // TransformDeps._successfulToolNames). Initialized here — one deps object
      // per turn — so it never leaks across turns; the stream consumer pushes
      // to it on tool.output and drains it onto metadata at turn.completed.
      _successfulToolNames: [],
      conversationHistory: this.conversationHistory,
      getSessionMetadata: () => this.stateManager.getSessionMetadata(),
      setSessionMetadata: (updater) => this.stateManager.setSessionMetadata(updater),
      updateSessionIdentity: (sid) => this.stateManager.updateSessionIdentity(sid),
      resolveInitialization: () => this.stateManager.resolveInitializationOnce(),
      setLastResponseMetadata: (m) => {
        this.lastResponseMetadata = m;
        // Mirror per-turn cost into the session-wide accumulator so the
        // trace writer's `session_sealed` payload reports cumulative
        // spend, not just the last turn. Guarded against provider quirks
        // where `totalCostUsd` is missing or non-numeric.
        if (typeof m.totalCostUsd === 'number' && Number.isFinite(m.totalCostUsd)) {
          this.sessionRunningCostUsd += m.totalCostUsd;
        }
        // Mirror per-turn tokens into the session-wide accumulator so the
        // `closure` event reports the cumulative tuple at termination.
        // `usage` is a Record<string, unknown> on ResponseMetadata so each
        // key must be type-narrowed before adding.
        const usage = m.usage;
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          const addCounter = (key: string, target: keyof typeof this.sessionRunningTokens): void => {
            const v = u[key];
            if (typeof v === 'number' && Number.isFinite(v)) {
              this.sessionRunningTokens[target] += v;
            }
          };
          addCounter('input_tokens', 'input');
          addCounter('output_tokens', 'output');
          addCounter('cache_read_input_tokens', 'cacheRead');
          addCounter('cache_creation_input_tokens', 'cacheCreation');
        }
        // Track the last stopReason so the closure event can carry the
        // model's own end-of-turn signal alongside the witness layer's
        // termination classification.
        if (typeof m.stopReason === 'string') {
          this.lastStopReason = m.stopReason;
        }
      },
      // Budget enforcement (C6): wire maxBudgetUsd from config so the stream
      // consumer can abort when cumulative cost crosses the ceiling.
      maxBudgetUsd: this.config.maxBudgetUsd,
      abortBudget: (reason) => {
        if (!this.abortController.signal.aborted) {
          this.abortController.abort(reason);
        }
      },
      // Witness layer: the stream consumer emits a `budget` trace event on
      // the same turn that crosses maxBudgetUsd, just before abortBudget
      // fires. Thread the writer through so the emission site doesn't
      // need to reach back into the session.
      ...(this.config.traceWriter ? { traceWriter: this.config.traceWriter } : {}),
    };
  }

  get state(): SessionState {
    return this.currentState;
  }

  get sessionId(): string | undefined {
    return this.stateManager.getSessionId();
  }

  /**
   * Working directory configured for this session, if any. Mirrors
   * {@link AgentConfig.cwd}. Read-only — `process.cwd()` is never mutated.
   */
  get cwd(): string | undefined {
    return this.config.cwd;
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * The session's lifecycle hook registry, if any. Exposed (read-only) so a
   * forking {@link SubagentManager} can resolve it from the *parent* at fork
   * time — the production wiring path, since the registry is constructed after
   * the manager. See `SubagentManager.forkSubagent`'s `options.parent.hookRegistry`
   * fallback. `undefined` when the session runs without hooks.
   */
  get hookRegistry(): HookRegistry | undefined {
    return this._hookRegistry;
  }

  /**
   * Abort the session with a caller-supplied reason BEFORE calling close().
   * Signal handlers (SIGINT, SIGTERM, SIGHUP) use this so that
   * deriveClosureReason sees a non-'closed' reason and returns 'abort'
   * instead of falling through to 'model_end_turn'.
   *
   * Contract: reason must NOT be 'closed' (reserved for the internal
   * close() path) and must NOT start with 'Budget ' or contain 'timed out'
   * (reserved for budget/timeout classification). Violations throw — see
   * deriveClosureReason for why: passing a reserved string would silently
   * cause this method to defeat its own purpose (e.g. abort('closed')
   * would still classify as model_end_turn).
   * Idempotent: if the signal is already aborted, this is a no-op.
   */
  abort(reason: string): void {
    // Invariant: deriveClosureReason interprets these patterns as
    // belonging to other classification branches (close, budget, timeout).
    // Allowing them here would re-introduce the misclassification bug
    // this method was added to fix.
    if (reason === 'closed' || reason.startsWith('Budget ') || reason.includes('timed out')) {
      throw new Error(`AgentSession.abort: reserved reason "${reason}" (use a caller-specific string like 'sigint')`);
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
  }

  async sendMessage(content: string, options: SendMessageOptions = {}): Promise<Message> {
    this.assertCanSend();

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

    const collectResponse = async (): Promise<Message> => {
      let result: Message | null = null;
      let streamedContent = '';

      this.currentState = options.stream ? 'streaming' : 'processing';

      for await (const event of this.sendMessageStreamInternal(content)) {
        if (event.type === 'chunk' && event.chunk.type === 'content') {
          streamedContent += event.chunk.content;
        }
        if (event.type === 'message' && event.message.role === 'assistant') {
          result = event.message;
        }
        if (event.type === 'error') {
          throw event.error;
        }
        if (event.type === 'done') {
          if (result) {
            return { ...result, metadata: event.metadata };
          }
          if (streamedContent) {
            return {
              role: 'assistant',
              content: streamedContent,
              metadata: event.metadata,
              timestamp: new Date(),
            };
          }
        }
      }

      if (result) return result;
      if (streamedContent) {
        return { role: 'assistant', content: streamedContent, timestamp: new Date() };
      }
      throw new Error('No assistant response received');
    };

    try {
      return await withTimeout(collectResponse(), timeoutMs, {
        controller: this.abortController,
        label: this.sessionId ?? 'session',
      });
    } finally {
      if (this.currentState === 'processing') this.currentState = 'idle';
    }
  }

  async sendMessageStructured<T>(
    content: string,
    schema: ZodType<T>,
    options: StructuredMessageOptions = {},
  ): Promise<T> {
    // Composes sendMessage() turns — no streaming-internals changes. Each
    // attempt is one model turn; on a schema mismatch we re-prompt with the
    // validation error so the model can self-correct, bounded by maxRetries.
    const { maxRetries = 2, injectSchemaPrompt = true, ...sendOpts } = options;
    // Communicate the target shape to the model (parity with the Claude Agent
    // SDK's outputFormat: json_schema). target: 'openapi-3.0' suppresses the
    // draft-2020-12 `$schema` marker the default emitter adds, keeping the block
    // compatible with both Anthropic and OpenAI-compatible backends.
    const schemaBlock = injectSchemaPrompt
      ? '\n\nRespond with ONLY a JSON object (optionally in a ```json fence) that conforms to this JSON Schema:\n```json\n' +
        JSON.stringify(z.toJSONSchema(schema, { target: 'openapi-3.0' })) +
        '\n```'
      : '';
    let lastError = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const prompt =
        attempt === 0
          ? content + schemaBlock
          : `Your previous response did not match the required JSON schema.\n` +
            `Validation error: ${lastError}\n` +
            'Respond again with ONLY a JSON object (optionally in a ```json fence) that satisfies the schema.' +
            schemaBlock;
      const message = await this.sendMessage(prompt, sendOpts);
      const candidate = extractStructuredOutput(message.content);
      const parsed = schema.safeParse(candidate);
      if (parsed.success) return parsed.data;
      lastError = parsed.error.message;
    }
    throw new Error(
      `structured output did not match schema after ${maxRetries + 1} attempt(s): ${lastError}`,
    );
  }

  async *sendMessageStream(content: string | ContentBlockParam[]): AsyncIterableIterator<OutputEvent> {
    this.assertCanSend();
    this.currentState = 'streaming';
    try {
      yield* this.sendMessageStreamInternal(content);
    } finally {
      if (this.currentState === 'streaming') this.currentState = 'idle';
    }
  }

  private async *sendMessageStreamInternal(content: string | ContentBlockParam[]): AsyncIterableIterator<OutputEvent> {
    if (this.initPromise) await this.initPromise;

    // End any in-flight Shift+Tab ring gesture: submitting a turn means the
    // user actually RESTED in the current mode, so a transient-default stash
    // from `setPermissionMode` must not survive into a later `default → plan`
    // (which would wrongly restore bypass after real work in default). See
    // {@link PlanExitBridge}.
    this.planExit.clearModeBeforeDefault();

    // Fold queued hook context into THIS message so it rides along with the
    // user's text instead of becoming a turn of its own — see
    // `queueFrameworkContext` for the displacement bug this prevents.
    const effectiveContent = this.withPendingFrameworkContext(content);

    const historySummary =
      typeof effectiveContent === 'string'
        ? effectiveContent
        : this.summarizeContentBlocks(effectiveContent);

    const userMessage: Message = { role: 'user', content: historySummary, timestamp: new Date() };
    this.conversationHistory.push(userMessage);
    this.inputStream.pushUserMessage(effectiveContent);

    // Durable ledger: initialization is deferred to here (not the
    // constructor) because the provider-issued session id only exists after
    // `session.init` — which `initPromise` above has just drained.
    this.ensureLedger();
    this.ledger.recordUser(historySummary);

    const deps = this.buildTransformDeps();

    try {
      while (true) {
        const result = await this.providerIterator.next();
        if (result.done) break;
        const event = result.value;
        const output = transformProviderEvent(event, deps);

        if (output) {
          if (output.type === 'done') {
            this.turnCount++;
            // A completed turn clears a prior turn's provider error so the seal
            // status reflects the FINAL turn's outcome (e.g. a turn that errored
            // and was then retried successfully is not sealed as `failed`).
            this.sawProviderError = false;
          } else if (output.type === 'error') {
            // Terminal-cause flag: a per-turn provider error (HTTP / auth /
            // stream failure) must flip the eventual clean close from a silent
            // `succeeded` / `model_end_turn` to `failed` / `abort`.
            this.sawProviderError = true;
          }
          this.ledger.recordEvent(output);
          yield output;
          if (output.type === 'done' || output.type === 'error') break;
        }
      }
    } finally {
      if (this.currentState === 'streaming') this.currentState = 'idle';
    }
  }

  /**
   * Create the session ledger writer on first use, deferring to
   * {@link LedgerLifecycle.ensure}. Deferred to the first turn (not the
   * constructor) because the provider-issued session id only exists after
   * `session.init`. Metadata is passed as a lazy accessor so it is read only
   * when a writer is actually created, not on the per-turn no-op path.
   */
  private ensureLedger(): void {
    this.ledger.ensure({
      depth: this.config.depth,
      parentSessionId: this.config.parentSessionId,
      sessionId: this.sessionId,
      fallbackModel: String(this.config.model),
      tracePath: this.config.traceWriter?.getTracePath(),
      getMetadata: () => this.getSessionMetadata(),
    });
  }

  /**
   * Append an AFK remote-control `elicitation` record to this session's own
   * ledger. No-op when the session is unledgered (subagent, ledger disabled,
   * or no provider session id yet) — the caller's keyboard fallback still
   * works regardless (channel is additive, scope.lock invariant #3).
   *
   * Used by the REPL AFK ledger channel (`makeLedgerChannelHandler`'s injected
   * `emitElicitation`): the handler must NOT own a second `SessionLedgerWriter`
   * (fd leak / spurious `closed` record), so it appends through the session's
   * lifecycle-managed writer here. A watching Telegram daemon renders the
   * appended `elicitation` to the operator's phone. Additive: changes no
   * existing path.
   */
  recordLedgerElicitation(reqId: string, request: ElicitationRequest): void {
    this.ledger.recordElicitation(reqId, request);
  }

  private summarizeContentBlocks(blocks: ContentBlockParam[]): string {
    const textParts: string[] = [];
    let imageCount = 0;

    for (const block of blocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        imageCount++;
      }
    }

    let summary = textParts.join(' ');
    if (imageCount > 0) {
      summary = summary ? `${summary} [+ ${imageCount} image(s)]` : `[+ ${imageCount} image(s)]`;
    }

    return summary || '[content block(s)]';
  }

  async interrupt(): Promise<void> {
    if (this.currentState !== 'streaming' && this.currentState !== 'processing') return;
    this.currentState = 'idle';
    await this.providerQuery.interrupt();
  }

  /**
   * Tear down the SDK lifecycle and rebuild it from the same `AgentConfig`,
   * yielding a session whose conversation context is empty. Forwarding the
   * literal string `/clear` to a provider does NOT clear context (the model
   * sees plain user text), so `/clear` in the CLI calls this method instead.
   *
   * Preserved across reset:
   *   - `config` (model, permissions, hooks, MCP servers, ...) — except for
   *     resume-context fields, which are stripped (see below) so that `/clear`
   *     after `/resume` yields a fresh conversation rather than silently
   *     re-attaching to the resumed session.
   *   - The internal `abortController`, so any external `config.abortSignal`
   *     keeps propagating to the new SDK lifecycle.
   *   - `hookRegistry` — SessionEnd fires for the old cycle, SessionStart
   *     fires for the new cycle inside `initSdkLifecycle`.
   *
   * Reset:
   *   - `providerQuery` + `providerIterator` — old ones are closed/returned.
   *   - `conversationHistory`, `turnCount`, `lastResponseMetadata`.
   *   - `inputStream`, `stateManager`.
   *   - `sessionEndDispatched` flag (so the new cycle's SessionEnd fires).
   *   - Resume-context fields on `this.config` (resume, sessionId,
   *     resumeHistory, resumeSessionAt, continue, forkSession) — see
   *     invariant below.
   */
  async reset(): Promise<void> {
    if (this.currentState === 'closed') {
      throw new Error('Cannot reset: session is closed');
    }
    if (this.abortController.signal.aborted) {
      throw new AbortError('Cannot reset: session aborted');
    }

    if (this.currentState === 'processing' || this.currentState === 'streaming') {
      try {
        await this.providerQuery.interrupt();
      } catch {
        // Provider interrupt may fail if already terminating; fall through.
      }
    }

    await this.dispatchSessionEndOnce('reset');
    await this.ledger.seal('reset');

    try {
      await this.providerQuery.close();
    } catch {
      // ignore
    }
    await this.providerIterator.return?.();
    if (this.initPromise) {
      await Promise.race([
        this.initPromise,
        new Promise((resolve) => setTimeout(resolve, RESET_DRAIN_TIMEOUT_MS)),
      ]).catch(() => {});
    }
    this.stateManager.resolveInitializationIfNeeded();

    // Invariant: /clear must yield a fresh conversation, not silently
    // re-attach to a previously-resumed session. /resume bakes
    // { resume, sessionId, resumeHistory } into this.config via
    // resumeConfigFor (src/cli/resume-session.ts:51), and the original CLI
    // flags (--continue / --resume / --resume-session-at / --fork-session)
    // can also seed resume-context at startup. initSdkLifecycle() below
    // threads this.config through buildInitialState() and the provider
    // query: buildInitialState seeds sessionIdentity from { sessionId,
    // resume, resumeSessionAt, continue, forkSession }; the Anthropic and
    // OpenAI-compatible providers each read { sessionId, resume,
    // resumeHistory } and (for Anthropic) thread them into the rebuilt
    // query's initSessionId + initialMessages. Without this strip, the
    // rebuilt provider query inherits the previous session's SDK id and
    // prior transcript, so the next user message is appended to the
    // resumed conversation instead of starting a new one.
    this.config = { ...this.config };
    delete this.config.resume;
    delete this.config.sessionId;
    delete this.config.resumeHistory;
    delete this.config.resumeSessionAt;
    delete this.config.continue;
    delete this.config.forkSession;

    try {
      this.initSdkLifecycle();
    } catch (err) {
      this.currentState = 'closed';
      throw new Error(
        `Session reset failed during lifecycle rebuild: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private async onAbort(): Promise<void> {
    void this.ledger.seal('abort');
    try {
      await this.providerQuery.interrupt();
    } catch {
      // Provider interrupt may fail if session is already torn down; swallow.
    }
  }

  async setModel(model?: AgentModelInput): Promise<void> {
    const resolved = resolveModelId(model);
    // Contract: forward the *requested* model (alias or full id) to the
    // provider — NOT the resolved wire id. Alias resolution is lossy for
    // context-window purposes (opus_1m and opus share a wire id but differ in
    // window), so the provider needs the alias to look up the right limit. It
    // resolves the wire id internally. A no-op `setModel()` (empty/undefined)
    // leaves the provider's model untouched rather than re-affirming the wire
    // id, which would discard a previously-set 1M alias.
    if (typeof model === 'string' && model.length > 0) {
      await this.providerQuery.setModel(model);
    }
    if (resolved) this.stateManager.setSessionMetadata((prev) => ({ ...prev, model: resolved }));
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Capture the plan bookkeeping (pre-plan mode to restore, Shift+Tab ring-
    // gesture memory) BEFORE flipping — the live mode is read here, the
    // transition rules live in PlanExitBridge. Then apply the actual flip.
    const current = this.stateManager.getSessionMetadata().permissionMode;
    this.planExit.recordModeTransition(mode, current);
    await this.providerQuery.setPermissionMode(mode);
    this.stateManager.setSessionMetadata((prev) => ({ ...prev, permissionMode: mode }));
  }

  /**
   * The permission mode the session was in immediately before entering plan
   * mode, or `undefined` if none was captured (never entered plan, or the prior
   * mode was 'autonomous'). An approved plan-exit restores this; callers fall
   * back to 'default' on `undefined`. See {@link PlanExitBridge}.
   */
  getPrePlanMode(): PermissionMode | undefined {
    return this.planExit.getPrePlanMode();
  }

  /**
   * Return and CLEAR the pending plan-exit implement-turn queued by an approved
   * `exit_plan_mode` call, or `undefined` if none is pending. The REPL drains
   * this at the top of each input-loop iteration (post-turn) and, when set,
   * atomically applies the deferred permission-mode flip then returns BOTH the
   * seed message and the flipped-to mode. Single-shot: a second call returns
   * `undefined` until the next approval.
   *
   * The mode flip is applied HERE (not in the handler) so the gate stays locked
   * in plan mode for the entire model turn and only opens at this clean
   * post-turn boundary — closing the mid-turn TOCTOU window.
   *
   * Invariant (#495): the flip updates the session's OWN mode (metadata +
   * provider), but the plan-mode gate and the REPL prompt read a SEPARATE mirror
   * — `stats.permissionMode` — which the session cannot reach. So the applied
   * `mode` is returned alongside the message; the REPL drain
   * (`loop-iteration.ts`) mirrors it onto `stats.permissionMode`, exactly as
   * `togglePlanMode` does for `/plan off`. Returning it (rather than exposing a
   * getter the caller re-reads) guarantees the mirror equals the applied value.
   *
   * If the deferred flip rejects (e.g. the provider's query handle is closing —
   * the same failure mode `togglePlanMode` guards for `/plan off`), the seed is
   * DROPPED and `undefined` is returned: we must not auto-submit the
   * implement-turn while still gate-locked in plan mode (it would only collect
   * write refusals), and the rejection must not escape into the REPL input loop
   * (which has no try/catch around this drain) and crash it. The model stays in
   * plan mode and can retry `exit_plan_mode`.
   */
  async takePendingPlanExitSeed(): Promise<{ message: string; mode: PermissionMode } | undefined> {
    const seed = this.planExit.takeSeed();
    if (seed === undefined) return undefined;
    try {
      await this.setPermissionMode(seed.mode);
    } catch (err) {
      debugLog(
        `⚠️ AgentSession: deferred plan-exit mode flip to '${seed.mode}' rejected; dropping implement-seed (staying in plan mode): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    return { message: seed.message, mode: seed.mode };
  }

  /**
   * Update the working directory for the current session.
   *
   * Three things happen atomically:
   *   1. `config.cwd` is updated so future `reset()` calls rebuild the
   *      provider query with the correct path.
   *   2. `providerQuery.setCwd(cwd)` is called (when the query supports it)
   *      to update both the **in-flight** dispatcher (via `setResolveBase`
   *      on the existing reference, so a turn already running picks up the
   *      new path on its next tool dispatch) and the **next turn's** state
   *      (rebuilt `userSystem` + fresh dispatcher with the new closure
   *      cwd). The provider also splices its shared `readRoots`/`writeRoots`
   *      arrays in place so containment checks accept paths under the new
   *      cwd, and any `/allow-dir` grants accumulated under the old cwd
   *      survive intact. The provider's `setCwd` ALSO re-anchors the forked
   *      sub-agent / skill executors so child tool calls land in the new cwd.
   *   3. The session's presence file is re-written with the new cwd (best-
   *      effort, top-level sessions only). This keeps the worktree-sweep
   *      live-session guard accurate after a born-named `afk -w` worktree is
   *      created on turn 1, so the sweep never reaps an in-use worktree.
   *
   * `AnthropicDirectQuery` implements both the in-flight propagation and
   * the next-turn rebuild. Providers that don't implement the optional
   * `setCwd` interface method (e.g. the Codex provider) only see step 1 —
   * the config field changes but the live query is unaffected.
   *
   * Does NOT mutate `process.cwd()`. Callers that need the host process's
   * working directory updated (e.g. to keep child-process spawn fallback
   * paths valid after a worktree rename) must call `process.chdir`
   * themselves AT a known safe site — `runFirstTurnAutoname` in the
   * interactive REPL is the only sanctioned caller today.
   */
  setCwd(cwd: string): void {
    this.config = { ...this.config, cwd };
    this.providerQuery.setCwd?.(cwd);
    // Keep the session's presence record pointing at the CURRENT cwd. A born-
    // named `afk -w` worktree is created on turn 1, AFTER presence was written
    // with the launch dir; without this update presence.cwd stays stale and the
    // worktree sweep's live-session guard can't see that the worktree is in use,
    // so it gets deleted mid-run. Fire-and-forget + self-guarding (no-op when no
    // presence file exists, e.g. sub-agents); only top-level sessions key one.
    if (this.config.sessionId !== undefined) {
      void updatePresenceCwd(this.config.sessionId, cwd);
    }
  }

  /**
   * Force the underlying provider to rebuild its SDK client from the current
   * credentials (e.g. re-read the macOS Keychain after `claude /login`).
   *
   * Returns `null` for providers that do not support a forced refresh
   * (api-key mode, the Codex provider, etc.) or when the refresh failed.
   * Returns `{ accountId, swapped }` on success — `swapped: true` means
   * the running session is now authenticated as a different account.
   *
   * Wired into the `/reauth` slash command. Mid-turn callers should
   * generally not invoke this directly; the retry layer auto-refreshes on
   * 401 and on detected 429-hot-swap (see `RetryLayer.forceClientRefresh`).
   */
  async reauth(): Promise<{ accountId: string; swapped: boolean } | null> {
    return (await this.providerQuery.reauth?.()) ?? null;
  }

  waitForInitialization(): Promise<SessionMetadata> {
    return this.stateManager.waitForInitialization();
  }

  getSessionIdentity(): SessionIdentity {
    return this.stateManager.getSessionIdentity();
  }

  getSessionMetadata(): SessionMetadata {
    return this.stateManager.getSessionMetadata();
  }

  getQuery(): ProviderQuery {
    return this.providerQuery;
  }

  supportedCommands(): Promise<SlashCommand[]> {
    return this.providerQuery.supportedCommands() as Promise<SlashCommand[]>;
  }

  supportedModels(): Promise<ModelInfo[]> {
    return this.providerQuery.supportedModels() as Promise<ModelInfo[]>;
  }

  supportedAgents(): Promise<AgentInfo[]> {
    return this.providerQuery.supportedAgents() as Promise<AgentInfo[]>;
  }

  getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return this.providerQuery.getContextUsage() as Promise<SDKControlGetContextUsageResponse>;
  }

  mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.providerQuery.mcpServerStatus() as Promise<McpServerStatus[]>;
  }

  accountInfo(): Promise<AccountInfo> {
    return this.providerQuery.accountInfo();
  }

  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult> {
    return this.providerQuery.rewindFiles(userMessageId, options);
  }

  async compact(): Promise<ProviderCompactResult> {
    if (this.currentState === 'closed') {
      throw new Error('Cannot compact: session is closed');
    }
    if (this.currentState !== 'idle') {
      return {
        compacted: false,
        reason: 'session-busy',
        messagesBefore: 0,
        messagesAfter: 0,
      };
    }
    const fn = this.providerQuery.compact?.bind(this.providerQuery);
    if (!fn) {
      return {
        compacted: false,
        reason: 'not-supported',
        messagesBefore: 0,
        messagesAfter: 0,
      };
    }
    // NOTE: 'compacting' state is set here for AgentSession.compact() only.
    // Auto-compact (AnthropicDirectQuery.compact()) is called directly inside
    // sendMessageStreamInternal while state is already 'streaming' — it does NOT
    // go through this method and therefore does NOT set 'compacting'. This is
    // intentional: auto-compact coincides with an already-non-idle state and
    // the assertCanSend guard in that path is never reached.
    this.currentState = 'compacting';
    try {
      return await fn();
    } finally {
      this.currentState = 'idle';
    }
  }

  getLastResponseMetadata(): ResponseMetadata | null {
    return this.lastResponseMetadata;
  }

  getOutputStream(): AsyncIterable<OutputEvent> {
    throw new Error(
      'getOutputStream() is not supported — use sendMessageStream() instead',
    );
  }

  /**
   * Queue hook-generated framework context (e.g. SubagentStop `injectContext`)
   * for delivery WITH the next real outbound user message.
   *
   * Contract: the provider consumes exactly one input-stream message per turn,
   * so delivering hook context via `pushUserMessage` makes it a turn of its
   * own — and a push that lands after the current turn ends displaces the
   * user's next real message by one queue position (every later send is then
   * answered by the message before it). Holding the context here and
   * prepending it in `sendMessageStreamInternal` keeps one send = one turn,
   * keeps the model's view identical to the ledger/transcript, and lets
   * undelivered context expire with the session.
   */
  queueFrameworkContext(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.pendingFrameworkContext.push(trimmed);
    debugLog(
      `AgentSession: queued framework context (${trimmed.length} chars) for the next user message`,
    );
  }

  /** Drain queued framework context, prepending it to the outbound content (FIFO). */
  private withPendingFrameworkContext(
    content: string | ContentBlockParam[],
  ): string | ContentBlockParam[] {
    if (this.pendingFrameworkContext.length === 0) return content;
    const prefix = this.pendingFrameworkContext.join('\n\n');
    this.pendingFrameworkContext = [];
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    return [{ type: 'text', text: prefix }, ...content];
  }

  getInputStreamRef(): Pick<InputStreamRef, 'pushUserMessage' | 'queueFrameworkContext'> {
    return {
      pushUserMessage: (content: string) => this.inputStream.pushUserMessage(content),
      queueFrameworkContext: (text: string) => this.queueFrameworkContext(text),
    };
  }

  getHistory(): readonly Message[] {
    return [...this.conversationHistory];
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  async close(): Promise<void> {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed';
    await this.ledger.seal('close');
    if (!this.abortController.signal.aborted) {
      this.abortController.abort('closed');
    }
    this.stateManager.resolveInitializationIfNeeded();
    // R2: await providerQuery.close() — mirrors the reset() path (line ~413).
    // External constraint: close() must drain the provider's async teardown
    // (HTTP keep-alive flush, MCP RPC drain) before the iterator is returned.
    // Without await, any future provider with an async close() races the drain.
    try {
      await this.providerQuery.close();
    } catch {
      // ignore
    }
    await this.providerIterator.return?.();
    if (this.initPromise) {
      try {
        await Promise.race([
          this.initPromise,
          new Promise((resolve) => setTimeout(resolve, RESET_DRAIN_TIMEOUT_MS)),
        ]);
      } catch {
        // ignore
      }
    }
    await this.dispatchSessionEndOnce('close');
  }

  private async dispatchSessionEndOnce(reason: string): Promise<void> {
    if (this.sessionEndDispatched) return;
    this.sessionEndDispatched = true;
    // Witness layer ordering:
    //   1. Emit `closure` — the terminal classification record that names
    //      WHY the session ended (model_end_turn, abort, budget_exceeded,
    //      timeout). Carries the final cost / token tuple + last stopReason.
    //   2. Seal the trace via session_sealed — the sealed-clean terminal
    //      record. Sealing happens BEFORE the SessionEnd hook fires so a
    //      hook-thrown exception cannot leave the trace `sealed-crashed`
    //      on the normal close path (a hook crash would surface as a
    //      separate `hook_decision: block` record, not erase the seal).
    //   3. Dispatch the SessionEnd hook.
    // Both 1 and 2 swallow writer errors so a broken sink never masks the
    // real session-end reason from observers downstream.
    const signals = this.closureSignals(reason);
    await emitClosureEvent(this.config.traceWriter, {
      ...signals,
      finalTurnCount: this.turnCount,
      finalCostUsd: this.sessionRunningCostUsd,
      runningTokens: this.sessionRunningTokens,
    }).catch(() => {});
    await sealTraceWriter(this.config.traceWriter, {
      ...signals,
      finalTurnCount: this.turnCount,
      finalCostUsd: this.sessionRunningCostUsd,
      subagentCompletedCount: this.subagentCompletedCount,
      subagentRunningTokens: this.subagentRunningTokens,
      subagentRunningCostUsd: this.subagentRunningCostUsd,
    }).catch(() => {});
    await dispatchSessionEnd(
      this._hookRegistry,
      {
        event: 'SessionEnd',
        sessionId: this.sessionId,
        reason,
        // Subagent provenance: lets session-scoped SessionEnd hooks (e.g. the
        // memory writer) skip forked children, which inherit this registry.
        parentSessionId: this.config.parentSessionId,
        // Authoritative trace path for the run-receipt hook. The witness dir is
        // keyed by the writer's session label (random on the one-shot path),
        // not by sessionId, so a hook cannot reconstruct it — thread it here.
        ...(this.config.traceWriter
          ? { tracePath: this.config.traceWriter.getTracePath() }
          : {}),
      },
      this.config.traceWriter ? { traceWriter: this.config.traceWriter } : {},
    );
  }

  /**
   * Snapshot the terminal-cause signals the closure emitters read. `reason` is
   * the `dispatchSessionEndOnce` string (close/reset/error) and doubles as the
   * seal reason. The derivation rules live in `./closure-emitter.ts`.
   */
  private closureSignals(reason: string): ClosureSignals {
    return {
      dispatchReason: reason,
      signal: this.abortController.signal,
      maxTurnsHit: this.maxTurnsHit,
      hookBlocked: this.hookBlocked,
      lastStopReason: this.lastStopReason,
      sawProviderError: this.sawProviderError,
    };
  }

  /**
   * Accumulate token and cost data from a completed subagent into the
   * session-level rollup that is included in `session_sealed`.
   *
   * Called by the `SubagentManager` (or any caller that constructs a
   * `SubagentHandle`) after each fork reaches `succeeded` status.
   * Thread-safe for sequential single-session use (no concurrent mutation).
   *
   * @param usage   - Token breakdown from {@link SubagentTrace.usage}.
   * @param costUsd - Optional USD cost for this subagent (from
   *                  {@link SubagentSucceededPayload.totalCostUsd}).
   */
  recordSubagentCompletion(
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
    costUsd?: number,
  ): void {
    this.subagentCompletedCount++;

    if (usage) {
      const add = (v: number | undefined, key: keyof typeof this.subagentRunningTokens): void => {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          this.subagentRunningTokens[key] += v;
        }
      };
      add(usage.inputTokens, 'input');
      add(usage.outputTokens, 'output');
      add(usage.cacheReadTokens, 'cacheRead');
      add(usage.cacheCreationTokens, 'cacheCreation');
    }

    if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) {
      this.subagentRunningCostUsd += costUsd;
    }
  }

  private assertCanSend(): void {
    if (this.currentState === 'closed') throw new Error('Cannot send message: session is closed');
    if (this.abortController.signal.aborted) {
      throw new AbortError('Cannot send message: session aborted');
    }
    if (this.currentState === 'processing' || this.currentState === 'streaming' || this.currentState === 'compacting') {
      throw new Error('Cannot send message: session is busy');
    }
    if (this.config.maxTurns && this.turnCount >= this.config.maxTurns) {
      // Origin signal for `max_turns_exceeded`: the throw below surfaces as a
      // generic dispatch error, so flag the specific cause for the closure.
      this.maxTurnsHit = true;
      throw new Error(`Maximum turns (${this.config.maxTurns}) exceeded`);
    }
  }

}
