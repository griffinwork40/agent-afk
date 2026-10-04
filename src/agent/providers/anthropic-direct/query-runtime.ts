/**
 * `ProviderQuery` for the `anthropic-direct` provider.
 *
 * Owns the **multi-turn outer loop** across user inputs:
 *   1. Synthesizes a `session.init` event before any user input arrives so
 *      `waitForInitialization()` resolves without a round-trip — Anthropic
 *      itself only assigns nothing here (we mint our own UUID).
 *   2. Pulls user turns from the harness `promptStream` one at a time, races
 *      against an internal `closedPromise` so `close()` unblocks a pending
 *      `next()`.
 *   3. Builds a fresh `AbortController` per turn (with `interrupt()` /
 *      `close()` early-abort handling), composes the OAuth-recipe headers +
 *      system prefix + `messages.create` params, and delegates the per-turn
 *      agentic loop to {@link runTurn}.
 *   4. Maintains a single `messages: MessageParam[]` array across turns —
 *      `runTurn` mutates it in place to append assistant + tool_result
 *      rounds, so the next iteration sees the full history.
 *
 * Imperative methods (`setModel`, `setPermissionMode`, `supportedModels`, ...)
 * are intentionally minimal: model is per-call so `setModel` only mutates the
 * stored value, and discovery methods return empty/static data so the
 * harness stays provider-agnostic. `setPermissionMode` updates a live field
 * read by {@link AnthropicDirectQuery.composeSystem} each turn — when the
 * mode is `'plan'`, a posture addendum is appended to the system payload
 * so the model knows planning is the only legal output (writes are still
 * refused at the hook layer; see `agent/plan-mode-gate`).
 *
 * @module agent/providers/anthropic-direct/query
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'node:crypto';
import { isFable51, resolveThinkingParam, resolveEffort } from './resolve-params.js';
import type {
  ProviderAccountInfo,
  ProviderAgentInfo,
  ProviderCommandInfo,
  ProviderCompactResult,
  ProviderContextUsage,
  ProviderEvent,
  ProviderMcpServerStatus,
  ProviderModelInfo,
  ProviderQuery,
  ProviderRewindConversationResult,
  ProviderRewindResult,
  ProviderUserTurn,
  RewindTarget,
} from '../../provider.js';
import { collectSupportedCommands } from '../shared/supported-commands.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { AnthropicToolDef } from './types.js';
import { type SessionState, createSessionState } from './query/session-state.js';
import { AbortCoordinator } from '../shared/abort-coordinator.js';
import { RetryLayer } from './query/retry-layer.js';
import type { HookRegistry } from '../../hooks.js';
import type { AnthropicDirectQueryOptions } from './query-options.js';
import { starterModels } from './query-options.js';
import { driveTurns, type TurnDriverContext } from './query-turn-driver.js';
import {
  accountInfoFor,
  computeContextUsage,
  mcpServerStatusList,
} from './query-capabilities.js';
import { composeQuerySystem } from './query-system.js';
import {
  setLiveCwd,
  setLiveModel,
  setLivePermissionMode,
  setLiveSystemPrompt,
} from './query-live-updates.js';
import { interruptedTurnCompletedEvent } from './query-events.js';
import type { JournalMessage } from '../../journal/index.js';
import {
  compactQueryHistory,
  queryRewindTargets,
  rewindQueryConversation,
} from './query-maintenance.js';

// Re-exported so the historical `from './query-runtime.js'` (and thence
// `query.js` / `index.js`) import paths stay valid after the #824 split.
export type { AnthropicDirectQueryOptions } from './query-options.js';

/**
 * Per-session `ProviderQuery` for the direct Anthropic SDK adapter.
 *
 * Constructed synchronously by {@link AnthropicDirectProvider.query}; the
 * outer `for await` loop is driven by the harness via the async-iterable
 * lane. Owns no SDK lifecycle of its own beyond the per-turn `messages.create`
 * calls and the per-turn `AbortController`.
 */
export class AnthropicDirectQuery implements ProviderQuery {
  private readonly initSessionId: string;
  private readonly promptStream: AsyncIterable<ProviderUserTurn>;
  /**
   * Mutable: updated by {@link updateCwdDependents} when the session's
   * working directory changes mid-session (e.g. after worktree rename).
   * Rebuilt by `AnthropicDirectProvider.setCwd()` and flushed here so
   * the next `composeSystem()` call picks up the new cwd line without
   * requiring a session reset.
   */
  private readonly maxTokens: number;
  private readonly tools: AnthropicToolDef[] | null;
  private readonly systemPrefix: ContentBlockParam[] | null;
  /** Resolved thinking config for the LAUNCH model. Used as the per-turn value
   * when no rawThinkingConfig is available (external/legacy callers). */
  private readonly thinking?: import('@anthropic-ai/sdk/resources').ThinkingConfigParam;
  /** Original unresolved ThinkingConfig from AgentConfig — used to re-resolve
   * per-turn when the current model changes mid-session. */
  private readonly rawThinkingConfig?: import('../../types/sdk-types.js').ThinkingConfig;
  /** Resolved effort for the LAUNCH model. */
  private readonly effort?: import('../../types/sdk-types.js').EffortLevel;
  /** Original unresolved caller effort — used to re-resolve per-turn on model switch. */
  private readonly rawEffort?: import('../../types/sdk-types.js').EffortLevel;
  /** The wire model id that was active when thinking/effort were first resolved. */
  private readonly launchModel: string;
  private readonly temperature?: number;
  private readonly baseUrl?: string;
  private readonly maxToolUseIterations?: number;
  private readonly softDeadlineMs?: number;
  private readonly traceWriter?: import('../../trace/index.js').TraceSink;
  /** Owning subagent id (fork only); stamped onto tool_call trace events. */
  private readonly subagentId?: string;
  /**
   * The session's configured working directory — `opts.cwd ?? process.cwd()`.
   * Surfaced via `TurnDriverContext.cwd` so `session.init` reports the
   * session's own directory rather than the host process's cwd — they differ
   * for daemon tasks whose per-task `cwd` or `AFK_DAEMON_CWD` is set.
   */
  private readonly _cwd: string;

  /**
   * Per-session mutable state — see {@link SessionState}. Held as a
   * single bag so the orchestrator's invariants live in one place and
   * future extractions (compact, abort, retry) can be passed the same
   * reference without each carrying its own copy.
   *
   * `userSystem` and `toolDispatcher` are mutable here even though they
   * look like construction-time values — `setCwd()` flushes both in
   * place so the next turn picks up the new working directory.
   *
   * `messages` is a stable array reference: `runTurn` mutates it in
   * place and `compact()` splices it; never reassign.
   */
  private readonly state: SessionState;

  /**
   * Per-session abort coordination — see {@link AbortCoordinator}.
   * Owns the only write path to the current-controller slot via
   * `abort.clear(controller)`; `abort.begin()` mints fresh controllers
   * and drains queued `interrupt()` / `close()` reasons onto them.
   */
  private readonly abort: AbortCoordinator;
  /**
   * Wraps `runTurn` with the OAuth-aware retry tiers (429 usage-limit
   * and 401 auth refresh). Owns the writable SDK client; the orchestrator
   * reads the current value via `this.retry.client` for paths like
   * `compact()` that bypass `runTurn`.
   */
  private readonly retry: RetryLayer;
  private readonly cwdDependentsFactory?: (cwd: string) => { userSystem: string; dispatcher: ToolDispatcher };
  private readonly systemPromptRebuildFactory?: (basePrompt: string | undefined) => string;
  private readonly onPermissionMode?: (mode: string) => void;
  private readonly mcpManager?: import('../../mcp/index.js').McpManager;
  private readonly hookRegistry?: HookRegistry;
  /** Shared live-throttle mailbox; wired to the client fetch callback. See options doc. */
  private readonly throttleQueue?: import('./throttle-queue.js').ThrottleQueue;
  private readonly fastModeController?: import('../../fast-mode.js').FastModeController;
  /** Inter-round steering callback; set via setBeforeNextRound() from the subagent layer. */
  private beforeNextRound?: () => string | undefined;

  constructor(opts: AnthropicDirectQueryOptions) {
    this.initSessionId = opts.sessionId ?? randomUUID();
    this.promptStream = opts.promptStream;
    this.maxTokens = opts.maxTokens;
    this.tools = opts.tools;
    this.systemPrefix = opts.systemPrefix;
    this.thinking = opts.thinking;
    if (opts.rawThinkingConfig !== undefined) this.rawThinkingConfig = opts.rawThinkingConfig;
    if (opts.effort !== undefined) this.effort = opts.effort;
    if (opts.rawEffort !== undefined) this.rawEffort = opts.rawEffort;
    this.launchModel = opts.model;
    if (opts.temperature !== undefined) this.temperature = opts.temperature;
    if (opts.baseUrl !== undefined) this.baseUrl = opts.baseUrl;
    if (opts.maxToolUseIterations !== undefined)
      this.maxToolUseIterations = opts.maxToolUseIterations;
    if (opts.softDeadlineMs !== undefined) this.softDeadlineMs = opts.softDeadlineMs;
    this.traceWriter = opts.traceWriter;
    if (opts.subagentId !== undefined) this.subagentId = opts.subagentId;
    this._cwd = opts.cwd ?? process.cwd();
    this.cwdDependentsFactory = opts.cwdDependentsFactory;
    this.systemPromptRebuildFactory = opts.systemPromptRebuildFactory;
    this.onPermissionMode = opts.onPermissionMode;
    this.mcpManager = opts.mcpManager;
    if (opts.hookRegistry !== undefined) this.hookRegistry = opts.hookRegistry;
    if (opts.throttleQueue !== undefined) this.throttleQueue = opts.throttleQueue;
    if (opts.fastModeController !== undefined) this.fastModeController = opts.fastModeController;
    if (opts.beforeNextRound !== undefined) this.beforeNextRound = opts.beforeNextRound;
    this.retry = new RetryLayer({
      client: opts.client,
      authMode: opts.authMode,
      initSessionId: this.initSessionId,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.tokenRefresher ? { tokenRefresher: opts.tokenRefresher } : {}),
      autoResumeOnUsageLimit: opts.autoResumeOnUsageLimit ?? true,
      ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
    });
    this.state = createSessionState({
      model: opts.model,
      ...(opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : {}),
      permissionMode: opts.permissionMode ?? 'default',
      userSystem: opts.userSystem,
      toolDispatcher: opts.toolDispatcher,
      ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
      ...(opts.messageJournal ? { messageJournal: opts.messageJournal } : {}),
      ...(opts.autoCompactThreshold !== undefined ? { autoCompactThreshold: opts.autoCompactThreshold } : {}),
      ...(opts.initialUsageInputTokens !== undefined ? { initialUsageInputTokens: opts.initialUsageInputTokens } : {}),
    });
    this.abort = new AbortCoordinator();
  }

  /**
   * Live view handed to the extracted turn driver.
   *
   * Invariant: every member is a getter or a method, never a captured value.
   * `state.toolDispatcher` and `state.currentModel` are swapped between turns
   * by `setCwd()` / `setModel()`, so a snapshot would freeze the session on
   * its launch-time dispatcher and model.
   */
  private turnDriverContext(): TurnDriverContext {
    const query = this;
    return {
      get initSessionId() { return query.initSessionId; },
      get promptStream() { return query.promptStream; },
      get state() { return query.state; },
      get abort() { return query.abort; },
      get retry() { return query.retry; },
      get maxTokens() { return query.maxTokens; },
      get tools() { return query.tools; },
      get thinking() {
        // Re-resolve per-turn when we have the original config AND the current
        // model has changed from the launch model — prevents a Sonnet-resolved
        // `{type:'enabled', budget_tokens}` from being replayed on Fable 5.1
        // (which only accepts adaptive thinking) after a mid-session /model switch.
        if (
          query.rawThinkingConfig !== undefined &&
          query.state.currentModel !== query.launchModel
        ) {
          const currentEffort = resolveEffort(query.rawEffort, query.state.currentModel);
          try {
            return resolveThinkingParam(
              query.rawThinkingConfig,
              query.maxTokens,
              query.state.currentModel,
              currentEffort,
            );
          } catch {
            // Resolution can throw for unsatisfiable configs; fall through to
            // the launch-time value so the session degrades rather than errors.
            return query.thinking;
          }
        }
        return query.thinking;
      },
      get effort() {
        // Re-resolve per-turn when the current model has changed from the launch
        // model — Fable 5.1 defaults to 'high', not Sonnet's 'max'.
        if (query.state.currentModel !== query.launchModel) {
          return resolveEffort(query.rawEffort, query.state.currentModel);
        }
        return query.effort;
      },
      get temperature() { return query.temperature; },
      get thinkingBlockBinding() {
        return isFable51(query.state.currentModel.toLowerCase()) && query.baseUrl === undefined
          ? ({ prefix_mismatch_behavior: 'drop_block' as const })
          : undefined;
      },
      get baseUrl() { return query.baseUrl; },
      get maxToolUseIterations() { return query.maxToolUseIterations; },
      get softDeadlineMs() { return query.softDeadlineMs; },
      get traceWriter() { return query.traceWriter; },
      get subagentId() { return query.subagentId; },
      get mcpManager() { return query.mcpManager; },
      get hookRegistry() { return query.hookRegistry; },
      get throttleQueue() { return query.throttleQueue; },
      get fastModeController() { return query.fastModeController; },
      get beforeNextRound() { return query.beforeNextRound; },
      get cwd() { return query._cwd; },
      composeSystem: () => query.composeSystem(),
      makeInterruptedTurnEvent: () => query.makeInterruptedTurnEvent(),
      compact: () => query.compact(),
    };
  }

  /** Wire a steering callback for inter-round message injection. Called from the subagent layer. */
  setBeforeNextRound(cb: (() => string | undefined) | undefined): void {
    this.beforeNextRound = cb;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    yield* driveTurns(this.turnDriverContext());
  }

  private composeSystem(): ContentBlockParam[] | null {
    return composeQuerySystem({
      state: this.state,
      systemPrefix: this.systemPrefix,
      ...(this.baseUrl !== undefined ? { baseUrl: this.baseUrl } : {}),
    });
  }

  async interrupt(reason: import('../../abort-reason.js').ProviderAbortReason = 'interrupted'): Promise<void> {
    this.abort.requestAbort(reason);
  }

  private makeInterruptedTurnEvent(): ProviderEvent {
    return interruptedTurnCompletedEvent(this.initSessionId);
  }

  async setModel(model?: string): Promise<void> {
    setLiveModel(this.state, model);
  }

  async setPermissionMode(mode: string): Promise<void> {
    setLivePermissionMode({
      state: this.state,
      mode,
      ...(this.onPermissionMode ? { onPermissionMode: this.onPermissionMode } : {}),
    });
  }

  setCwd(cwd: string): void {
    setLiveCwd({
      state: this.state,
      cwd,
      ...(this.cwdDependentsFactory
        ? { cwdDependentsFactory: this.cwdDependentsFactory }
        : {}),
    });
  }

  setSystemPrompt(basePrompt: string | undefined): boolean {
    return setLiveSystemPrompt({
      state: this.state,
      basePrompt,
      ...(this.systemPromptRebuildFactory
        ? { systemPromptRebuildFactory: this.systemPromptRebuildFactory }
        : {}),
    });
  }

  async supportedCommands(): Promise<ProviderCommandInfo[]> {
    return collectSupportedCommands();
  }

  async supportedModels(): Promise<ProviderModelInfo[]> {
    return starterModels();
  }

  async supportedAgents(): Promise<ProviderAgentInfo[]> {
    return [];
  }

  async getContextUsage(): Promise<ProviderContextUsage> {
    return computeContextUsage(this.state);
  }

  async mcpServerStatus(): Promise<ProviderMcpServerStatus[]> {
    return mcpServerStatusList(this.mcpManager);
  }

  async accountInfo(): Promise<ProviderAccountInfo> {
    return accountInfoFor(this.retry.authMode);
  }

  /**
   * Force-rebuild the underlying Anthropic SDK client from the current
   * keychain credentials. See {@link RetryLayer.forceClientRefresh} for the
   * detailed rationale (TL;DR: the SDK caches `authToken` at construction
   * time, so a fresh token in the keychain is not picked up without a new
   * client instance).
   *
   * `runInput.client` for any **in-flight** turn is not retroactively
   * patched here — that runInput is owned by the turn generator and gets a
   * fresh `this.retry.client` read at the start of every new turn. The next
   * user message therefore sees the swapped client automatically.
   */
  async reauth(): Promise<{ accountId: string; oldAccountId: string; swapped: boolean } | null> {
    return this.retry.forceClientRefresh();
  }

  async rewindFiles(
    _userMessageId: string,
    _options?: { dryRun?: boolean },
  ): Promise<ProviderRewindResult> {
    return {
      canRewind: false,
      error:
        'anthropic-direct provider does not support file checkpoint rewind',
    };
  }

  async compact(): Promise<ProviderCompactResult> {
    const r = await compactQueryHistory({
      state: this.state, abort: this.abort, retry: this.retry,
      initSessionId: this.initSessionId,
      ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
    });
    if (r.compacted) this.state.lastUsage = null; // #962: stale usage → false-positive
    return r;
  }

  listRewindTargets(): RewindTarget[] {
    return queryRewindTargets(this.state);
  }

  /** Live conversation in journal form (router `/model` swap carry); undefined without a journal. */
  journalSnapshot(): JournalMessage[] | undefined {
    const sync = this.state.journalSync;
    if (!sync.enabled) return undefined;
    sync.sync(this.state.messages);
    return sync.snapshot();
  }

  async rewindConversation(
    turnIndex: number,
  ): Promise<ProviderRewindConversationResult> {
    return rewindQueryConversation(this.state, this.abort, turnIndex);
  }

  close(): void {
    this.state.closed = true;
    this.abort.requestAbort('closed');
    this.abort.markClosed();
  }
}
