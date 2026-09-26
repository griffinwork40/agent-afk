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
import { OutputBroadcast } from './output-broadcast.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { TraceWriter } from '../trace/writer.js';
import type { HookRegistry } from '../hooks.js';
import { providerAbortReason } from '../abort-reason.js';
import type {
  ProviderCommandInfo,
  ProviderCompactResult,
  ProviderEvent,
  ProviderQuery,
  ProviderRewindConversationResult,
  RewindTarget,
} from '../provider.js';
import { RESET_DRAIN_TIMEOUT_MS } from '../timeout.js';
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
  StructuredMessageOptions,
} from '../types.js';
import type { ZodType } from 'zod';
import { QueryInputStream } from './input-iterable.js';
import { LedgerLifecycle } from './ledger-lifecycle.js';
import { PlanExitBridge } from './plan-exit-bridge.js';
import type { ElicitationRequest } from '../types/sdk-types.js';
import { resolveModelId } from './model-resolution.js';
import { deriveOrigin, deriveActor } from './session-identity.js';
import { wireAbortSignal } from './session-setup.js';
import { SessionStateManager } from './session-state.js';
import { getSessionGrantsPath, sessionLabelFromTracePath } from '../../paths.js';
import {
  capJsonlBySize,
  SESSION_GRANTS_MAX_BYTES,
  SESSION_GRANTS_KEEP_TAIL_LINES,
} from '../log-retention.js';
import { sweepWitnessTree, WITNESS_SWEEP_START_DELAY_MS } from '../witness-sweep.js';
import { sweepSessionSidecars, SESSION_SIDECAR_SWEEP_START_DELAY_MS } from '../session-sidecar-sweep.js';
import { AccountingAccumulator } from './accounting-accumulator.js';
import type { SubagentOutputRecorder } from './subagent-output-capture.js';
import { buildProviderLifecycle, ProviderInitializer } from './provider-lifecycle.js';
import { TurnStreamRunner } from './turn-stream-runner.js';
import { SessionShutdown } from './session-shutdown.js';
import { resetSession } from './session-reset.js';
import * as compact from './session-compact.js';
import * as ss from './session-send.js';
import * as sc from './session-config.js';
import { toModelInfo, toAgentInfo, toContextUsageResponse, toMcpServerStatus } from './provider-type-mappers.js';


export class AgentSession implements IAgentSession {
  /**
   * Owner-only handle retained for `sealTraceWriter()` calls. This capability
   * is supplied separately from `AgentConfig`, so write-only sinks and configs
   * inherited by forks can never be promoted to seal owners.
   */
  private readonly ownedTraceWriter: TraceWriter | undefined;
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
  /** Number of inbound messages submitted, including attempts that end in a
   * provider error and therefore never increment `turnCount`. */
  private inboundMessageCount = 0;
  /**
   * Opt-in subagent output recorder, created lazily on the first turn and
   * reused for the life of the session so a multi-turn child produces ONE
   * transcript. `undefined` = not yet attempted; `null` = capture disabled.
   */
  private subagentOutputRecorder: SubagentOutputRecorder | null | undefined;
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
  private readonly ownsTraceSeal: boolean;
  private stateManager!: SessionStateManager;
  /**
   * Accounting accumulator: cost/token rollups, terminal-cause flags, and
   * subagent completion counts extracted from the per-field inline state.
   * See {@link AccountingAccumulator} for the full field inventory.
   */
  private readonly accounting = new AccountingAccumulator();
  /**
   * Durable per-session event ledger (`~/.afk/state/sessions/<id>/events.jsonl`).
   * Created lazily on the first turn once the provider has issued a session id.
   * Top-level sessions only — subagents are observable via the bg-job log and
   * witness traces; mirroring them here would multiply files per session.
   * Inert (no writer) when disabled (env opt-out), gated off (subagent), or
   * after close. Lifecycle glue lives in {@link LedgerLifecycle}.
   */
  private readonly ledger = new LedgerLifecycle();
  private readonly outputBroadcast = new OutputBroadcast();
  private readonly shutdown: SessionShutdown;
  private runner!: TurnStreamRunner;

  constructor(config: AgentConfig, ownedTraceWriter?: TraceWriter) {
    // Invariant: seal ownership requires the caller to explicitly supply the
    // owner handle (second arg) AND it must be the same object as
    // config.traceWriter. The TraceSink/TraceWriter type split prevents forks
    // from promoting a write-only sink — the two-arg ceremony is defence-in-depth.
    this.ownsTraceSeal =
      ownedTraceWriter !== undefined &&
      config.traceWriter === ownedTraceWriter;
    this.ownedTraceWriter = this.ownsTraceSeal ? ownedTraceWriter : undefined;
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

    this.shutdown = new SessionShutdown({
      getConfig: () => this.config,
      getAbortController: () => this.abortController,
      getHookRegistry: () => this._hookRegistry,
      accounting: this.accounting,
      getTurnCount: () => this.turnCount,
      getSessionId: () => this.sessionId,
      ownedTraceWriter: this.ownedTraceWriter,
      ownsTraceSeal: this.ownsTraceSeal,
    });

    // Witness layer: mark the start of provider/SDK initialization so
    // downstream tooling can compute the session_init phase duration.
    const configuredModel = String(config.model);
    void emitSessionPhase(config.traceWriter, {
      phase: 'session_init_start',
      model: configuredModel,
      resolvedModel: resolveModelId(config.model) ?? configuredModel,
      origin: deriveOrigin(config.surface),
      actor: deriveActor(config.parentSessionId),
    });

    this.initSdkLifecycle();

    // Bound the write-only session-grants audit log at session start. Top-level
    // sessions only: subagents share the parent's path, so re-running per fork
    // is redundant and widens the rewrite-collision window. Fire-and-forget +
    // silent-fail — best-effort housekeeping that must never delay or break
    // construction.
    if (this.config.parentSessionId === undefined) {
      void capJsonlBySize(getSessionGrantsPath(), {
        maxBytes: SESSION_GRANTS_MAX_BYTES,
        keepTailLines: SESSION_GRANTS_KEEP_TAIL_LINES,
      });
      // Bound the witness tree the same way. Self-throttled by a stamp file,
      // so this is a no-op on all but one session start every few hours (#849).
      //
      // Invariant: deferred off the construction path and `.unref()`ed, exactly
      // as BackgroundAgentRegistry's eviction sweep is. The walk is O(files in
      // the witness tree), so running it inline competes with the session's own
      // first-turn I/O. The unref also means a short-lived process exits without
      // ever paying for it.
      const witnessSweepTimer = setTimeout(() => {
        void sweepWitnessTree({
          activeLabel:
            sessionLabelFromTracePath(this.config.traceWriter?.getTracePath()) ?? undefined,
        });
      }, WITNESS_SWEEP_START_DELAY_MS);
      witnessSweepTimer.unref();
      const sidecarSweepTimer = setTimeout(() => {
        void sweepSessionSidecars({ activeSessionId: this.sessionId });
      }, SESSION_SIDECAR_SWEEP_START_DELAY_MS);
      sidecarSweepTimer.unref();
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
    const { stateManager, inputStream, providerQuery, providerIterator } =
      buildProviderLifecycle(this.config);

    this.stateManager = stateManager;
    this.inputStream = inputStream;
    this.providerQuery = providerQuery;
    this.providerIterator = providerIterator;

    this.conversationHistory = [];
    this.turnCount = 0;
    this.lastResponseMetadata = null;
    this.accounting.reset();
    this.shutdown.reset();
    this.currentState = 'idle';
    this.pendingFrameworkContext = [];

    this.runner = new TurnStreamRunner({
      getConfig: () => this.config,
      getAbortController: () => this.abortController,
      getProviderIterator: () => this.providerIterator,
      stateManager: this.stateManager,
      accounting: this.accounting,
      ledger: this.ledger,
      outputBroadcast: this.outputBroadcast,
      conversationHistory: this.conversationHistory,
      getInitPromise: () => this.initPromise,
      getSessionId: () => this.sessionId,
      getState: () => this.currentState,
      setState: (s) => { this.currentState = s; },
      getLastResponseMetadata: () => this.lastResponseMetadata,
      setLastResponseMetadata: (m) => { this.lastResponseMetadata = m; },
      getPendingFrameworkContext: () => this.pendingFrameworkContext,
      setPendingFrameworkContext: (v) => { this.pendingFrameworkContext = v; },
      getInboundMessageCount: () => this.inboundMessageCount,
      incInboundMessageCount: () => ++this.inboundMessageCount,
      getTurnCount: () => this.turnCount,
      incTurnCount: () => { this.turnCount++; },
      getSubagentOutputRecorder: () => this.subagentOutputRecorder,
      setSubagentOutputRecorder: (r) => { this.subagentOutputRecorder = r; },
      getProviderQuery: () => this.providerQuery,
      getLedgerMetadata: () => this.stateManager.getSessionMetadata(),
    });

    const initializer = new ProviderInitializer(
      this.config,
      this.abortController.signal,
      this.accounting,
      this.shutdown,
      this._hookRegistry,
      (text) => this.queueFrameworkContext(text),
    );
    this.initPromise = initializer.run(
      () => this.providerIterator,
      () => this.runner.buildTransformDeps(),
      this.stateManager,
    );
  }

  get state(): SessionState { return this.currentState; }
  get sessionId(): string | undefined { return this.stateManager.getSessionId(); }
  get cwd(): string | undefined { return this.config.cwd; }
  get abortSignal(): AbortSignal { return this.abortController.signal; }
  get hookRegistry(): HookRegistry | undefined { return this._hookRegistry; }

  /**
   * Abort the session with a caller-supplied reason BEFORE calling close().
   * Signal handlers (SIGINT, SIGTERM, SIGHUP) use this so that
   * deriveClosureReason sees a non-'closed' reason and returns 'abort'
   * instead of falling through to 'model_end_turn'.
   *
   * Contract: reason must NOT be 'closed' (reserved for the internal
   * close() path) and must NOT start with 'Budget ' or contain 'timed out'
   * (reserved for budget/timeout classification). Violations throw.
   * Idempotent: if the signal is already aborted, this is a no-op.
   */
  abort(reason: string): void {
    if (reason === 'closed' || reason.startsWith('Budget ') || reason.includes('timed out')) {
      throw new Error(`AgentSession.abort: reserved reason "${reason}" (use a caller-specific string like 'sigint')`);
    }
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  private makeSendDeps() {
    return {
      getConfig: () => this.config,
      getAbortController: () => this.abortController,
      getState: () => this.currentState,
      setState: (s: SessionState) => { this.currentState = s; },
      getSessionId: () => this.sessionId,
      runner: this.runner,
      getInputStream: () => this.inputStream,
      getProviderQuery: () => this.providerQuery,
      planExit: this.planExit,
    };
  }

  async sendMessage(content: string, options: SendMessageOptions = {}): Promise<Message> {
    return ss.sendMessage(content, options, this.makeSendDeps());
  }

  async sendMessageStructured<T>(content: string, schema: ZodType<T>, options: StructuredMessageOptions = {}): Promise<T> {
    return ss.sendMessageStructured(content, schema, options, this.makeSendDeps());
  }

  async *sendMessageStream(content: string | ContentBlockParam[]): AsyncIterableIterator<OutputEvent> {
    yield* ss.sendMessageStream(content, this.makeSendDeps());
  }

  async interrupt(): Promise<void> {
    await ss.interrupt(this.makeSendDeps());
  }

  setBeforeNextRound(cb: (() => string | undefined) | undefined): void {
    ss.setBeforeNextRound(cb, this.makeSendDeps());
  }

  /**
   * Tear down the SDK lifecycle and rebuild it from the same `AgentConfig`,
   * yielding a session whose conversation context is empty. Forwarding the
   * literal string `/clear` to a provider does NOT clear context (the model
   * sees plain user text), so `/clear` in the CLI calls this method instead.
   */
  async reset(): Promise<void> {
    await resetSession({
      getState: () => this.currentState,
      setState: (s) => { this.currentState = s; },
      getAbortController: () => this.abortController,
      getProviderQuery: () => this.providerQuery,
      getProviderIterator: () => this.providerIterator,
      getInitPromise: () => this.initPromise,
      getShutdown: () => this.shutdown,
      getLedger: () => this.ledger,
      getStateManager: () => this.stateManager,
      reinitialize: (patch) => {
        this.config = patch(this.config);
        this.initSdkLifecycle();
      },
    });
  }

  private async onAbort(): Promise<void> {
    void this.ledger.seal('abort');
    try {
      await this.providerQuery.interrupt(providerAbortReason(this.abortController.signal.reason));
    } catch {
      // Provider interrupt may fail if session is already torn down; swallow.
    }
  }

  private makeConfigDeps(): sc.ConfigDeps {
    return {
      getConfig: () => this.config,
      setConfig: (patch) => { this.config = patch(this.config); },
      getProviderQuery: () => this.providerQuery,
      getStateManager: () => this.stateManager,
      getPlanExit: () => this.planExit,
      pushSidebandEvent: (event) => this.pushSidebandEvent(event),
    };
  }

  async setModel(model?: AgentModelInput): Promise<void> { return sc.setModel(model, this.makeConfigDeps()); }
  async setPermissionMode(mode: PermissionMode): Promise<void> { return sc.setPermissionMode(mode, this.makeConfigDeps()); }
  setSystemPrompt(basePrompt: string | undefined): boolean { return sc.setSystemPrompt(basePrompt, this.makeConfigDeps()); }
  setCwd(cwd: string): void { return sc.setCwd(cwd, this.makeConfigDeps()); }
  async reauth(): Promise<{ accountId: string; swapped: boolean } | null> { return sc.reauth(this.makeConfigDeps()); }

  getPrePlanMode(): PermissionMode | undefined { return this.planExit.getPrePlanMode(); }
  // Invariant: called by the REPL after construction to wire a queue-check
  // predicate into exit_plan_mode — when it returns true the handler skips the
  // elicitation picker so the queued user message drains first.
  setPlanExitQueueCheck(fn: () => boolean): void { if (this.config.planExitControls) this.config.planExitControls.hasPendingUserMessage = fn; }
  async takePendingPlanExitSeed(): Promise<{ message: string; mode: PermissionMode } | undefined> { return sc.takePendingPlanExitSeed(this.makeConfigDeps()); }

  waitForInitialization(): Promise<SessionMetadata> { return this.stateManager.waitForInitialization(); }
  getSessionIdentity(): SessionIdentity { return this.stateManager.getSessionIdentity(); }
  getSessionMetadata(): SessionMetadata { return this.stateManager.getSessionMetadata(); }
  getQuery(): ProviderQuery { return this.providerQuery; }

  supportedCommands(): Promise<ProviderCommandInfo[]> { return this.providerQuery.supportedCommands(); }
  supportedModels(): Promise<ModelInfo[]> { return this.providerQuery.supportedModels().then((ms) => ms.map(toModelInfo)); }
  supportedAgents(): Promise<AgentInfo[]> { return this.providerQuery.supportedAgents().then((as_) => as_.map(toAgentInfo)); }
  getContextUsage(): Promise<SDKControlGetContextUsageResponse> { return this.providerQuery.getContextUsage().then(toContextUsageResponse); }
  mcpServerStatus(): Promise<McpServerStatus[]> { return this.providerQuery.mcpServerStatus().then((ms) => ms.map(toMcpServerStatus)); }
  accountInfo(): Promise<AccountInfo> { return this.providerQuery.accountInfo(); }
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult> { return this.providerQuery.rewindFiles(userMessageId, options); }
  compact(): Promise<ProviderCompactResult> { return compact.compactSession(this.makeCompactDeps()); }
  listRewindTargets(): RewindTarget[] { return compact.listRewindTargets(this.makeCompactDeps()); }
  rewindConversation(turnIndex: number): Promise<ProviderRewindConversationResult> { return compact.rewindConversation(turnIndex, this.makeCompactDeps()); }

  private makeCompactDeps() {
    return {
      getState: () => this.currentState,
      setState: (s: SessionState) => { this.currentState = s; },
      getProviderQuery: () => this.providerQuery,
    };
  }

  getLastResponseMetadata(): ResponseMetadata | null { return this.lastResponseMetadata; }
  getOutputStream(): AsyncIterable<OutputEvent> { return this.outputBroadcast.subscribe(); }

  /**
   * Queue hook-generated framework context (e.g. SubagentStop `injectContext`)
   * for delivery WITH the next real outbound user message.
   *
   * Contract: the provider consumes exactly one input-stream message per turn,
   * so delivering hook context via `pushUserMessage` makes it a turn of its
   * own — and a push that lands after the current turn ends displaces the
   * user's next real message by one queue position (every later send is then
   * answered by the message before it). Holding the context here and
   * prepending it in `sendMessageStreamInternal` keeps one send = one turn.
   */
  queueFrameworkContext(text: string): void { this.runner.queueFrameworkContext(text); }

  getInputStreamRef(): Pick<InputStreamRef, 'pushUserMessage' | 'queueFrameworkContext'> {
    return {
      pushUserMessage: (content: string) => this.inputStream.pushUserMessage(content),
      queueFrameworkContext: (text: string) => this.queueFrameworkContext(text),
    };
  }

  getHistory(): readonly Message[] { return [...this.conversationHistory]; }
  getTurnCount(): number { return this.turnCount; }

  async close(): Promise<void> {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed';
    this.outputBroadcast.close();
    await this.ledger.seal('close');
    if (!this.abortController.signal.aborted) this.abortController.abort('closed');
    this.stateManager.resolveInitializationIfNeeded();
    try {
      await this.providerQuery.close();
    } catch {
      // ignore
    }
    await this.providerIterator.return?.();
    if (this.initPromise) {
      try {
        await Promise.race([this.initPromise, new Promise((resolve) => setTimeout(resolve, RESET_DRAIN_TIMEOUT_MS))]);
      } catch {
        // ignore
      }
    }
    await this.shutdown.dispatchOnce('close');
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
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number },
    costUsd?: number,
  ): void {
    this.accounting.recordSubagentCompletion(usage, costUsd);
  }

  /**
   * Push a sideband OutputEvent (subagent lifecycle, background-job state,
   * plan-mode transition) into the broadcast channel and ledger WITHOUT starting
   * a new provider turn. Called by SubagentManager and BackgroundAgentRegistry
   * wired at bootstrap time so lifecycle events reach getOutputStream() consumers
   * (e.g. the web-UI SSE channel). No-op when the session is closed.
   */
  pushSidebandEvent(event: OutputEvent): void {
    if (this.currentState === 'closed') return;
    this.ledger.recordEvent(event);
    this.outputBroadcast.push(event);
  }

  /**
   * Append an AFK remote-control `elicitation` record to this session's own
   * ledger. No-op when the session is unledgered (subagent, ledger disabled,
   * or no provider session id yet).
   */
  recordLedgerElicitation(reqId: string, request: ElicitationRequest): void {
    this.ledger.recordElicitation(reqId, request);
  }
}
