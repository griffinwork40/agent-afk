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
 *     `abort.closedPromise` so `close()` unblocks a "waiting for next turn"
 *     state
 *   - each user turn opens a new abort scope via `abort.begin()`;
 *     `interrupt()` aborts it — see shared/abort-coordinator.ts
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

import { pathContainmentBypassed } from '../../permission-policy.js';
import type { TraceSink } from '../../trace/index.js';
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
import { contextLimitFor, autoCompactLimitFor } from '../../model-limits.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { collectSupportedCommands } from '../shared/supported-commands.js';
import { TurnTrace } from '../shared/turn-trace.js';
import { debugLog } from '../../../utils/debug.js';
import {
  formatAuthDiagnostic,
} from './auth.js';
import { type OpenAIMessage } from './messages.js';
import {
  toolDefsToOpenAIFunctions,
  type OpenAIFunctionTool,
} from './loop.js';
import { resolveWireMode, envFlagEnabled, type WireMode } from './responses-config.js';
import { env } from '../../../config/env.js';
import { isGrokModelId } from '../xai/pricing.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import {
  contextWindowTokensUsed,
  buildContextUsageFields,
  shouldAutoCompact,
  resolveAutoCompactThreshold,
} from '../shared/auto-compact.js';
import { AbortCoordinator, CLOSED_SENTINEL } from '../shared/abort-coordinator.js';
import { HookBlockedError } from '../../../utils/errors.js';

import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/handlers/exit-plan-mode.js';
import { OpenAIJournalWiring } from './query/journal-wiring.js';

import {
  normalizePermissionMode,
  resolveReasoningEffort,
} from './query/model-params.js';
import { resolveClientFactory, buildOpenAIAdmissionFetch } from './query/client.js';
import { FastTierSession } from './query/fast-tier-session.js';
import {
  runTurnInner,
  type TurnDriverContext,
} from './query/turn-driver.js';
import {
  runCompactHistory,
  type CompactHandlerContext,
} from './query/compact-handler.js';
import { OPENAI_COMPATIBLE_MODELS } from './query/capabilities.js';
import type { OpenAICompatibleQueryOptions } from './query/query-options.js';
export type { OpenAICompatibleQueryOptions } from './query/query-options.js';
import { applySetSystemPrompt, type BeforeNextRoundCallback } from './query/live-updates.js';
import {
  listOpenAIUserTurns,
  rewindOpenAIConversation,
} from './query/rewind-conversation.js';
export { buildQueryFromConfig } from './query/build-query.js';

// Re-exported from the extracted query/ submodules so existing import sites
// (sibling tests + index.ts) keep resolving these from './query.js'.
export { __setRetryBaseDelay, __setRetryAfterMaxWaitMs } from './query/retry.js';
export { __setOpenAIClientFactory } from './query/client.js';
export type { OpenAIClientFactory } from './query/client.js';
export { isOSeriesModel, mapEffortForOpenAI } from './query/model-params.js';
export { resolveReasoningEffort };

const PROVIDER_NAME = 'openai-compatible';





/**
 * OpenAI-compatible ProviderQuery implementation.
 *
 * Satisfies {@link TurnDriverContext} so the extracted turn-driver and
 * iteration helpers can accept `this` directly — no plain object literal
 * intermediary, which would break mutable field access (currentModel,
 * currentPermissionMode, closed, responsesCompactionUnavailable).
 */
export class OpenAICompatibleQuery implements ProviderQuery, TurnDriverContext, CompactHandlerContext {
  /** @internal Package-visible so extracted query/ modules can satisfy TurnDriverContext without an object literal intermediary. */
  readonly client: OpenAI;
  /** @internal Package-visible for context-interface satisfaction. */
  readonly opts: OpenAICompatibleQueryOptions;
  /** @internal Package-visible so extracted query/ modules can read the synthesized session id. */
  readonly initSessionId: string;
  /** @internal Package-visible so turn-driver.ts can dispatch tool calls. */
  readonly toolDispatcher: ToolDispatcher | undefined;
  private readonly onPermissionMode?: (mode: string) => void;
  private readonly onCwdChange?: (cwd: string) => void;
  private readonly systemPromptRebuildFactory?: (basePrompt: string | undefined) => string;
  /** Mutable ref so setSystemPrompt() and setCwd() share the same base value. */
  private readonly _currentBasePromptRef: { current: string | undefined } = { current: undefined };
  /** Inter-round steering callback; set via setBeforeNextRound(). */
  private _beforeNextRound: BeforeNextRoundCallback = undefined;
  get beforeNextRound(): BeforeNextRoundCallback { return this._beforeNextRound; }
  /** Pre-computed tool catalog — recomputed only if dispatcher.toolDefs changes (it doesn't today). */
  private readonly openAITools: OpenAIFunctionTool[] | undefined;
  /** @internal Which wire this session speaks: Chat Completions (default) or Responses. */
  readonly wireMode: WireMode;
  /** @internal Static OpenAI list prices apply only when using the official public API endpoint. */
  readonly useOpenAIPricing: boolean;
  /** @internal Witness-layer trace writer (optional). Mirrors RunTurnInput.traceWriter in anthropic-direct. */
  readonly traceWriter: TraceSink | undefined;
  /** @internal Package-visible for fast-tier delegation from turn-driver. */
  readonly fastTier: FastTierSession;

  /** @internal Running conversation state for multi-turn sessions (journal-seeded on resume). */
  readonly priorTurns: OpenAIMessage[];
  /** @internal Message-journal commit points + resume seeding (query/journal-wiring.ts). */
  readonly journal: OpenAIJournalWiring;

  /**
   * Private backing for `currentModel`. Changed only through `setModel()`.
   * Public via `get currentModel()` — interfaces see the getter, not the field.
   */
  private _currentModel: string;
  /**
   * Private backing for `currentPermissionMode`. Changed only through
   * `setPermissionMode()`, which also calls `toolDispatcher.setAllowAll`.
   * Public via `get currentPermissionMode()`.
   */
  private _currentPermissionMode: string;

  /** Current model — live getter; interfaces (TurnDriverContext, IterationContext) are satisfied here. */
  get currentModel(): string { return this._currentModel; }
  /** Current permission mode — live getter. */
  get currentPermissionMode(): string { return this._currentPermissionMode; }

  /**
   * Latched `true` when a Responses-wire summarize (history compaction) fails in
   * a way that PROVES the backend refuses the request. Per-session; never reset.
   *
   * Contract: the ONLY writer is `markResponsesCompactionUnavailable()` (called by
   * compact-handler.ts). All other reads are through the context interfaces (which
   * expose it as `readonly`). The field itself is private to prevent direct external writes.
   */
  private _responsesCompactionUnavailable = false;

  /** Read accessor for the responses-compaction-unavailable latch. */
  get responsesCompactionUnavailable(): boolean { return this._responsesCompactionUnavailable; }
  /**
   * Latch the responses-compaction-unavailable flag. Called exactly once by
   * `runSummarizeViaResponses` in compact-handler.ts when the Responses-wire
   * backend provably refuses compaction. Never reset during the session.
   */
  markResponsesCompactionUnavailable(): void { this._responsesCompactionUnavailable = true; }

  /**
   * Per-session abort coordination — see {@link AbortCoordinator}.
   */
  readonly abort = new AbortCoordinator();

  /**
   * Private backing for `closed`. Set by `close()`, which also unblocks the
   * prompt-stream race via `abort.markClosed()`.
   * Public via `get closed()` — sub-generators read it live on every iteration.
   */
  private _closed = false;

  /** Whether the session has been closed — live getter. */
  get closed(): boolean { return this._closed; }

  /**
   * Last completed turn's accumulated usage — drives `getContextUsage()`.
   * Mutable — updated by finishTurn (via FinishTurnContext) and mid-round live refresh.
   * @internal Package-visible for FinishTurnContext satisfaction.
   */
  lastUsage: ProviderUsage | null = null;

  /**
   * Auto-compaction threshold as a fraction of the context window (0–1), or
   * `undefined` when disabled.
   */
  private readonly autoCompactThreshold: number | undefined;

  constructor(opts: OpenAICompatibleQueryOptions) {
    this.opts = opts;
    this.initSessionId = opts.synthesizedSessionId;
    this._currentModel = opts.model;
    this._currentPermissionMode = normalizePermissionMode(opts.config.permissionMode);
    this.toolDispatcher = opts.toolDispatcher;
    this.onPermissionMode = opts.onPermissionMode;
    this.onCwdChange = opts.onCwdChange;
    this.systemPromptRebuildFactory = opts.systemPromptRebuildFactory;
    this.traceWriter = opts.traceWriter;
    this.fastTier = new FastTierSession(opts.fastTier);
    this.autoCompactThreshold = resolveAutoCompactThreshold(opts.config.autoCompact, opts.model);

    // Pre-compute the OpenAI tool catalog once.
    if (this.toolDispatcher) {
      const td = this.toolDispatcher as { toolDefs?: readonly unknown[] };
      if (Array.isArray(td.toolDefs) && td.toolDefs.length > 0) {
        this.openAITools = toolDefsToOpenAIFunctions(
          td.toolDefs as Parameters<typeof toolDefsToOpenAIFunctions>[0],
        );
      }
    }

    // Resolve the wire (Chat Completions vs Responses) once.
    const responsesOptIn =
      (opts.useResponsesApi ?? false) || envFlagEnabled(env.AFK_OPENAI_USE_RESPONSES);
    const wire = resolveWireMode(opts.auth, responsesOptIn);
    this.wireMode = wire.mode;
    this.useOpenAIPricing =
      (wire.baseURL === undefined && opts.baseURL === undefined) ||
      (isGrokModelId(opts.model) && opts.config.forceXaiOAuth !== true);

    this.journal = new OpenAIJournalWiring(opts.config);
    this.lastUsage = this.journal.resumedUsage();
    this.priorTurns = this.journal.initialTurns();

    if (opts.auth.apiKey === null) {
      this.client = null as unknown as OpenAI;
    } else {
      const ctor = resolveClientFactory();
      const clientOpts: { apiKey: string; baseURL?: string; defaultHeaders?: Record<string, string>; fetch?: typeof globalThis.fetch } = {
        apiKey: opts.auth.apiKey,
      };
      const baseURL = wire.baseURL ?? opts.baseURL;
      if (baseURL !== undefined) clientOpts.baseURL = baseURL;
      if (wire.headers !== undefined) clientOpts.defaultHeaders = wire.headers;
      else if (opts.defaultHeaders !== undefined) clientOpts.defaultHeaders = opts.defaultHeaders;
      const admissionFetch = buildOpenAIAdmissionFetch(baseURL);
      if (admissionFetch !== undefined) clientOpts.fetch = admissionFetch;
      this.client = ctor(clientOpts);
    }
  }

  /**
   * The OpenAI tool catalog to advertise for THIS turn. Filters out the
   * plan-exit tool on non-plan turns — mirroring the anthropic-direct
   * per-turn filter. Required by TurnDriverContext.
   * @internal Package-visible for TurnDriverContext.
   */
  activeOpenAITools(): OpenAIFunctionTool[] | undefined {
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
      cwd: this.opts.config.cwd || process.cwd(),
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
        const nextOrClose = await Promise.race([promptIterator.next(), this.abort.closedPromise]);
        if (nextOrClose === CLOSED_SENTINEL) break;
        const turnResult = nextOrClose as IteratorResult<ProviderUserTurn>;
        if (turnResult.done) break;

        yield* this.runTurn(turnResult.value.content);

        // Auto-compaction fires at the natural turn boundary.
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
                const compactResult = await this.compactHistory('token_threshold');
                if (compactResult.compacted) this.lastUsage = null;
              } catch (compactErr) {
                if (!(compactErr instanceof HookBlockedError)) throw compactErr;
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
   * Delegates to the extracted `runTurnInner` in query/turn-driver.ts;
   * `this` satisfies `TurnDriverContext` so all live field reads work.
   */
  private async *runTurn(content: ProviderUserTurn['content']): AsyncGenerator<ProviderEvent> {
    const controller = this.abort.begin();
    if (controller.signal.aborted) return;

    const turnStartTime = Date.now();
    const taskId = randomUUID();

    const trace = new TurnTrace(controller.signal, this.traceWriter, 'openai-compatible');
    this.fastTier.beginTurn(this.currentModel);
    try {
      // Pass `this` — which implements TurnDriverContext — so every mutable
      // field read inside runTurnInner is always live (no stale snapshot).
      yield* runTurnInner(this, content, controller, turnStartTime, taskId);
    } finally {
      trace.finish(Date.now() - turnStartTime);
    }
  }

  // ---- ProviderQuery surface ------------------------------------------------

  async interrupt(reason: import('../../abort-reason.js').ProviderAbortReason = 'interrupted'): Promise<void> {
    this.abort.requestAbort(reason);
  }

  /**
   * Summarize older history into a short preamble, in place.
   * Delegates to query/compact-handler.ts; passes `this` as context so
   * mutable fields (currentModel, closed, responsesCompactionUnavailable)
   * are always read live.
   */
  async compact(): Promise<ProviderCompactResult> {
    const result = await runCompactHistory(this, 'manual');
    if (result.compacted) this.lastUsage = null;
    return result;
  }

  private async compactHistory(trigger: CompactionTrigger): Promise<ProviderCompactResult> {
    return runCompactHistory(this, trigger);
  }

  async setModel(model?: string): Promise<void> {
    if (model !== undefined) this._currentModel = resolveModelId(model) ?? model;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this._currentPermissionMode = normalizePermissionMode(mode);
    const allowAll = pathContainmentBypassed(this._currentPermissionMode);
    this.toolDispatcher?.setAllowAll?.(allowAll);
    this.onPermissionMode?.(this._currentPermissionMode);
  }

  setCwd(cwd: string): void {
    this.toolDispatcher?.setResolveBase?.(cwd);
    this.onCwdChange?.(cwd);
  }

  setSystemPrompt(basePrompt: string | undefined): boolean {
    return applySetSystemPrompt(this.opts.config, basePrompt, this.systemPromptRebuildFactory, this._currentBasePromptRef);
  }

  setBeforeNextRound(cb: BeforeNextRoundCallback): void {
    this._beforeNextRound = cb;
  }

  listRewindTargets(): import('../../provider.js').RewindTarget[] {
    return listOpenAIUserTurns(this.priorTurns);
  }

  async rewindConversation(turnIndex: number): Promise<import('../../provider.js').ProviderRewindConversationResult> {
    const result = rewindOpenAIConversation(this.priorTurns, this.abort, this.closed, turnIndex);
    if (result.rewound) {
      // Clear stale usage so getContextUsage() and checkContextOverflow() reflect
      // the rewound (shorter) transcript — mirrors the compact path (query.ts:398).
      this.lastUsage = null;
      // Sync the journal immediately so a crash between now and the next model
      // request does not resurrect the discarded turns — mirrors the anthropic-direct
      // rewind path (anthropic-direct/query/rewind-conversation.ts).
      this.journal.sync(this.priorTurns);
    }
    return result;
  }

  async supportedCommands(): Promise<ProviderCommandInfo[]> {
    return collectSupportedCommands();
  }

  async supportedModels(): Promise<ProviderModelInfo[]> {
    return OPENAI_COMPATIBLE_MODELS;
  }

  async supportedAgents(): Promise<ProviderAgentInfo[]> {
    return [];
  }

  async getContextUsage(): Promise<ProviderContextUsage> {
    const last = this.lastUsage;
    const contextLimit = contextLimitFor(this.currentModel);
    let percentage: number | undefined;
    if (last && contextLimit > 0) {
      const used = contextWindowTokensUsed(last);
      percentage = Math.min(100, Math.max(0, (used / contextLimit) * 100));
    }
    const { totalTokens, apiUsage } = buildContextUsageFields(last);
    return {
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

  /** Live conversation in journal form (router `/model` swap carry); undefined without a journal. */
  journalSnapshot(): ReturnType<OpenAIJournalWiring['snapshot']> { return this.journal.snapshot(this.priorTurns); }

  close(): void {
    // Invariant: the `closed` flag and the close promise must be updated
    // together — sub-generators poll the flag each loop iteration while the
    // outer loop is parked on the promise, so resolving one without the
    // other leaves a reader stuck.
    this._closed = true;
    this.abort.requestAbort('closed');
    this.abort.markClosed();
    debugLog(`🟢 ${PROVIDER_NAME}: closed`);
  }
}


