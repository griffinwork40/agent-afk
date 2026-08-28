/**
 * Lightweight subagent manager for forking child sessions.
 *
 * Subagents are implemented as regular `AgentSession` instances configured to
 * fork from a parent session's persisted conversation when available.
 *
 * Features:
 * - **Permission bubbling**: pass a `canUseTool` to the constructor and all
 *   spawned children forward their tool-permission requests up to that handler.
 * - **Transitive abort**: the manager owns an {@link AbortGraph}. Parent abort
 *   propagates to all children; child abort notifies the parent via
 *   {@link SubagentManager.onChildAborted}. A `parentAbortSignal` wires the
 *   manager's root to an external controller so aborting a parent session
 *   cascades through nested managers.
 * - **Output schemas**: sub-agents may be given a Zod schema; the final
 *   assistant message is parsed and returned as typed `output` on the result,
 *   with `schemaError` populated on mismatch.
 *
 * @module agent/subagent
 */

import type { CanUseTool } from './types/sdk-types.js';
import type { WorkspaceStore } from './workspace/workspace-store.js';
import { AbortGraph, type ChildAbortedListener } from './abort-graph.js';
import type { HookRegistry } from './hooks.js';
import { AgentSession } from './session.js';

import type { AgentConfig } from './types.js';
import type { SubagentProgressSink } from './types/session-types.js';
import { dispatchSubagentStart } from './subagent-hooks.js';
import type { AbortOrigin, TraceSink } from './trace/index.js';
import type { Surface } from './awareness/types.js';
import { getCurrentSink } from './_lib/skill-sink-channel.js';
import { touchWorktreeOccupancy, startWorktreeOccupancyHeartbeat } from './worktree-occupancy.js';
import { resolveWorktreeMainRoot } from './worktree-read-root.js';
import { type ReadScopeInputs } from './subagent-read-scope.js';
import { resolveReadScope, composeWriteRoots } from './subagent/resolve-fork-scope.js';
import { providerForModel, type BundledProviderName } from './providers/index.js';
import { validatePhaseRole } from './subagent/fork-validation.js';
import { assembleChildConfig } from './subagent/fork-child-config.js';
import { emitForkStarted, appendForkTelemetry } from './subagent/fork-lifecycle.js';
import {
  SubagentHandleImpl,
  type SubagentHandle,
} from './subagent/handle.js';
import { resolveForkInputs } from './subagent/fork-resolution.js';
import type { SubagentStatus, SubagentResult, SubagentTrace } from './subagent/result.js';
import { CompletedCache } from './subagent/completed-cache.js';
import { SubagentLogWriter } from './subagent/log.js';

// Re-export types for public API
export type { SubagentStatus, SubagentResult, SubagentTrace, SubagentHandle };

// Contract: the default budgets and the fork-time option types moved to
// ./subagent/{constants,fork-types}.ts (#829). They are imported for internal
// use by SubagentManager below AND re-exported here unchanged, so every
// existing `from './subagent.js'` importer keeps working untouched.
import {
  DENY_ELICITATION,
  SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS,
  SUBAGENT_BACKGROUND_TIMEOUT_MS,
  SUBAGENT_DRAIN_TIMEOUT_MS,
  resolveSubagentTimeoutMs,
  resolveSubagentIdleTimeoutMs,
} from './subagent/constants.js';

import type {
  ForkParent,
  ForkSubagentOptions,
  SubagentManagerOptions,
} from './subagent/fork-types.js';

export {
  DENY_ELICITATION,
  SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS,
  SUBAGENT_BACKGROUND_TIMEOUT_MS,
  SUBAGENT_DRAIN_TIMEOUT_MS,
  resolveSubagentTimeoutMs,
  resolveSubagentIdleTimeoutMs,
};
export type { ForkParent, ForkSubagentOptions, SubagentManagerOptions };


export class SubagentManager {
  private readonly active = new Map<string, SubagentHandleImpl<unknown>>();
  /** Recently-completed subagent handles for `/tasks:view` memory-first path. */
  readonly completed = new CompletedCache();
  private readonly parentCanUseTool: CanUseTool | undefined;
  private readonly hookRegistry: HookRegistry | undefined;
  private readonly progressSink: SubagentProgressSink | undefined;
  private readonly parentApiKey: string | undefined;
  private readonly parentBaseUrl: string | undefined;
  // Derived once from options.parentModel (constructor). Source of truth for
  // the both-direction cross-provider credential gate in forkSubagent —
  // avoids guessing the parent's provider from the key's shape at fork time.
  private readonly parentProvider: BundledProviderName | undefined;
  // Parent session model string, retained for the #652 cross-provider child
  // model coercion in forkSubagent: coerceCrossProviderChildModel needs the
  // concrete parent model as the OpenAI/gpt substitute target, not just the
  // derived parentProvider above.
  private readonly parentModel: string | undefined;
  // Mutable so AgentSession.setCwd can re-anchor forks after a born-named
  // `afk -w` worktree is created mid-session. Read at fork time (forkSubagent),
  // so updating it makes every subsequent fork inherit the new worktree cwd.
  private parentCwd: string | undefined;
  // The parent session's effective read roots, for read-scope inheritance
  // (see ./subagent-read-scope). `undefined` = derive from parentCwd
  // (defined → confined base; undefined → unconfined parent → read-open child).
  private readonly parentReadRoots: string[] | undefined;
  // Per-cwd cache of the resolved main-repo root for worktree children (see
  // `resolveWorktreeMainRoot`). Forks overwhelmingly share one cwd, so this
  // collapses N git subprocesses to one per distinct cwd for the whole
  // manager lifetime. `undefined` value = resolved-and-there-is-none, so the
  // Map's `.has()` distinguishes "not yet resolved" from "resolved to none".
  private readonly worktreeMainRootCache = new Map<string, string | undefined>();
  // Not readonly: a REPL `/resume` swaps the session out from under this
  // long-lived manager and hands it a fresh writer via `setTraceWriter`,
  // because the outgoing session sealed the one captured here (#731).
  private parentTraceWriter: TraceSink | undefined;
  private readonly parentSurface: Surface | undefined;
  private readonly parentAbortSignal: AbortSignal | undefined;
  private readonly workspaceStore: WorkspaceStore | undefined;
  /** Session label for subagent-log directory naming. Matches the label
   *  given to `setTasksRegistry` so writer and reader agree on the path. */
  private readonly sessionLabel: string | undefined;
  private readonly abortGraph: AbortGraph;
  private readonly rootId: string;
  private rootController: AbortController;
  private counter = 0;
  private onSubagentSucceededCb:
    | ((usage: import('./subagent/result.js').SubagentTrace['usage'], costUsd: number | undefined) => void)
    | undefined;

  constructor(options: SubagentManagerOptions = {}) {
    this.parentCanUseTool = options.canUseTool;
    this.hookRegistry = options.hookRegistry;
    this.progressSink = options.progressSink;
    this.parentApiKey = options.apiKey;
    this.parentBaseUrl = options.baseUrl;
    this.parentProvider =
      options.parentModel !== undefined ? providerForModel(options.parentModel) : undefined;
    this.parentModel = options.parentModel;
    this.parentCwd = options.cwd;
    this.parentReadRoots = options.parentReadRoots;
    this.parentTraceWriter = options.traceWriter;
    this.parentSurface = options.surface;
    this.parentAbortSignal = options.parentAbortSignal;
    this.onSubagentSucceededCb = options.onSubagentSucceeded;
    this.workspaceStore = options.workspaceStore;
    this.sessionLabel = options.sessionLabel;
    // Witness layer: AbortGraph receives the writer at construction so
    // cascades fire `abort` events without per-call plumbing.
    this.abortGraph = new AbortGraph(options.traceWriter);
    this.rootId = `manager-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.rootController = new AbortController();
    this.abortGraph.register(this.rootId, this.rootController);

    if (options.parentAbortSignal) {
      const parentSignal = options.parentAbortSignal;
      if (parentSignal.aborted) {
        this.rootController.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          'abort',
          () => {
            if (!this.rootController.signal.aborted) {
              this.rootController.abort(parentSignal.reason);
            }
          },
          { once: true },
        );
      }
    }
  }

  list(): Array<Pick<SubagentHandle, 'id' | 'status'>> {
    return [...this.active.values()].map((h) => ({ id: h.id, status: h.status }));
  }

  get(id: string): SubagentHandle | undefined {
    return this.active.get(id) ?? this.completed.get(id)?.handle;
  }

  /** Subscribe to aborts of any subagent under this manager. */
  onChildAborted(listener: ChildAbortedListener): () => void {
    return this.abortGraph.onChildAborted(this.rootId, listener);
  }

  /**
   * Wire a callback that fires after each subagent this manager forks
   * reaches `succeeded` status. Intended to be called once — immediately
   * after the parent {@link AgentSession} is constructed — so the session
   * can accumulate subagent token data into the `session_sealed` rollup.
   *
   * Late-binding is necessary because {@link SubagentManager} is typically
   * constructed before the session (e.g. in `bootstrap.ts`) to avoid a
   * circular reference. Calling this more than once replaces the prior
   * callback silently.
   */
  setOnSubagentSucceeded(
    cb: (usage: import('./subagent/result.js').SubagentTrace['usage'], costUsd: number | undefined) => void,
  ): void {
    this.onSubagentSucceededCb = cb;
  }

  /**
   * Re-anchor the cwd inherited by future forks. Called (transitively, via the
   * provider's `setCwd`) when the session's working directory changes — most
   * importantly when a born-named `afk -w` worktree is created on turn 1, after
   * this manager was constructed in the launch dir. Existing in-flight children
   * are unaffected; only forks dispatched after this call inherit `cwd`.
   */
  setCwd(cwd: string): void {
    this.parentCwd = cwd;
    // Invalidate any memoized main-root for this exact path. A worktree can be
    // deleted and recreated at the SAME path mid-session (sweep + re-create),
    // which would otherwise hand every subsequent fork a stale mainRoot from
    // the cache (#441). setCwd is rare (born-named worktree creation on turn 1),
    // so forcing one re-resolution on the next fork costs nothing.
    this.worktreeMainRootCache.delete(cwd);
  }

  /**
   * Re-point the writer inherited by future forks.
   *
   * Contract: mirrors {@link SubagentManager.setCwd} — existing in-flight
   * children keep the writer they were forked with; only forks dispatched
   * after this call inherit `writer`. Called (via the bootstrap cascade) on a
   * REPL `/resume`, where the outgoing session seals the writer this manager
   * captured at construction; without the re-point, every post-resume fork
   * would emit its lifecycle events into a sealed writer and be silently
   * dropped (#731).
   */
  setTraceWriter(writer: TraceSink | undefined): void {
    this.parentTraceWriter = writer;
    this.abortGraph.setTraceWriter(writer);
  }

  /**
   * The read-scope inputs this manager applies to its forks — the parent's
   * `readRoots` (may be undefined = derive from cwd) and `cwd`. Used to
   * propagate read scope transitively: a forked child that builds its OWN
   * manager for grandchildren computes its inherited read roots from these
   * inputs (via {@link computeInheritedReadRoots}) and passes the result as the
   * grandchild manager's `parentReadRoots`, so a read-open (or `/allow-dir`-
   * widened) scope is not silently re-narrowed one nesting level down.
   */
  getReadScopeInputs(): ReadScopeInputs {
    return { parentReadRoots: this.parentReadRoots, parentCwd: this.parentCwd };
  }

  /**
   * Resolve (and memoize) the main-repo root for a worktree `cwd`. Returns the
   * main repository root when `cwd` is inside a linked git worktree distinct
   * from the main worktree, else undefined. Best-effort — never throws.
   *
   * Cached per cwd so a fan-out of subagents sharing one worktree pays a single
   * `git rev-parse`, not one per fork.
   */
  private async resolveMainRootForCwd(cwd: string): Promise<string | undefined> {
    if (this.worktreeMainRootCache.has(cwd)) {
      return this.worktreeMainRootCache.get(cwd);
    }
    const mainRoot = await resolveWorktreeMainRoot(cwd);
    this.worktreeMainRootCache.set(cwd, mainRoot);
    return mainRoot;
  }

  /**
   * Abort the entire managed tree.
   *
   * @param reason   Forwarded to every cascade victim's AbortController. Read
   *                 by handlers via `signal.reason`. Stringified into the
   *                 `abort` trace event's `reason` field.
   * @param origin   Witness-layer classification of who initiated the abort.
   *                 Defaults to `'user_signal'`. Pass `'timeout'`, `'budget'`,
   *                 etc. when the caller has richer context than the reason
   *                 string conveys.
   */
  abortAll(reason?: unknown, origin: AbortOrigin = 'user_signal'): void {
    this.abortGraph.abort(this.rootId, reason, origin);
  }

  /**
   * Fork a new subagent session.
   *
   * If the parent session has a `sessionId`, the child is created with
   * `resume=<parentSessionId>` and `forkSession=true`, producing an independent
   * conversation that begins from the parent's persisted state.
   *
   * When a `hookRegistry` is resolvable — from `config.hookRegistry`, the
   * manager, OR the forking parent session (`options.parent.hookRegistry`) —
   * `SubagentStart` is dispatched *before* the child session is created. A
   * blocked hook throws `HookBlockedError` and no session / handle is created.
   */
  async forkSubagent<T = unknown>(options: ForkSubagentOptions<T>): Promise<SubagentHandle<T>> {
    // Throws synchronously before any side-effect when phaseRole conflicts
    // with config.provider. See ./subagent/fork-validation.ts.
    validatePhaseRole(options);

    // Pure resolution chain: ID, registry, trace writer, model coercion,
    // timeout. See ./subagent/fork-resolution.ts for precedence comments.
    const {
      id, resume, registry, effectiveTraceWriter, effectiveChildModel, coercedFrom, effectiveTimeoutMs,
    } = resolveForkInputs({
      options,
      counter: ++this.counter,
      managerHookRegistry: this.hookRegistry,
      parentTraceWriter: this.parentTraceWriter,
      parentModel: this.parentModel,
    });

    // SubagentStart fires BEFORE session creation so a block truly prevents
    // the child from existing. Abort precedence is honored via rootController.
    if (registry) {
      await dispatchSubagentStart(
        registry,
        {
          event: 'SubagentStart',
          subagentId: id,
          parentSessionId: options.parent.sessionId,
        },
        {
          signal: this.rootController.signal,
          ...(effectiveTraceWriter ? { traceWriter: effectiveTraceWriter } : {}),
        },
      );
    }

    // Ordering constraint: the coercion warning fires AFTER hook dispatch so a
    // blocked fork never tells the operator it is "running" under a substituted
    // model. Before this extraction the warning was inline after the hook; the
    // resolution chain defers it via `coercedFrom` to preserve that ordering.
    if (coercedFrom !== undefined) {
      process.stderr.write(
        `[afk] subagent: child model "${coercedFrom}" cannot run on this ` +
          `session's OpenAI/ChatGPT backend — running it as "${effectiveChildModel ?? ''}" instead ` +
          `(set AFK_DEFAULT_SUBAGENT_MODEL to choose a different one).\n`,
      );
    }

    const childController = new AbortController();
    // External constraint: AbortGraph nodes registered before child construction
    // must be released if construction fails — otherwise graph accumulates orphan
    // nodes across forge/farm runs that retry on misconfigured models.
    // The try/catch below disposes the node on any synchronous construction error.
    this.abortGraph.register(id, childController);
    this.abortGraph.linkChild(this.rootId, id);

    // Read-scope inheritance (#416/#441 successor — see ./subagent-read-scope
    // and ./subagent/resolve-fork-scope). Invariants (Gap A/B/C, farm-pin,
    // unconfined-parent) are documented and enforced inside that helper.
    const effectiveChildCwd = options.config.cwd ?? this.parentCwd;
    const inheritedReadRoots = await resolveReadScope({
      parentReadRoots: this.parentReadRoots,
      parentCwd: this.parentCwd,
      effectiveChildCwd,
      callerReadRoots: options.config.readRoots,
      callerExtraReadRoots: options.config.extraReadRoots,
      resolveMainRoot: (cwd) => this.resolveMainRootForCwd(cwd),
    });

    // Write-root composition (#435): see ./subagent/resolve-fork-scope.
    const composedWriteRoots = composeWriteRoots(options.config.writeRoots, effectiveChildCwd);

    // Assemble the child AgentConfig. All fork-time invariants (seal ownership,
    // output cap, credential gating, anti-hang constraints, scope inheritance,
    // phase-role enforcement) live in assembleChildConfig with their Invariant:/
    // External constraint: comments. See ./subagent/fork-child-config.ts.
    const childConfig: AgentConfig = assembleChildConfig({
      options,
      id,
      resume,
      registry,
      effectiveChildModel,
      effectiveTimeoutMs,
      inheritedReadRoots,
      composedWriteRoots,
      childController,
      parentCwd: this.parentCwd,
      parentApiKey: this.parentApiKey,
      parentBaseUrl: this.parentBaseUrl,
      parentProvider: this.parentProvider,
      parentTraceWriter: this.parentTraceWriter,
      parentSurface: this.parentSurface,
      parentCanUseTool: this.parentCanUseTool,
      workspaceStore: this.workspaceStore,
    });

    // Occupancy touch: subagents never write presence files (top-level-only
    // by design — presence.ts), so the worktree sweep's live-session guard
    // cannot see a fork occupying a worktree. Refresh the worktree's meta
    // (pid + createdAt) instead, resetting the sweep's age clock and PID
    // liveness. Fire-and-forget: the helper swallows all errors and no-ops
    // for cwds outside `.afk-worktrees/`, so it can never delay or fail the
    // fork. Single wiring point — agent/skill/compose/farm dispatches all
    // converge here, whether cwd came per-call or via manager inheritance.
    //
    // Ordering constraint: one touch only protects the tree for the sweep's
    // MIN_EMPTY_AGE_MS (1h), after which a still-running child ages back into
    // the `empty` verdict and is force-removed mid-flight (#759). So arm a
    // heartbeat alongside the initial touch, and capture its stop handle HERE —
    // before the session is constructed — so every exit path below (settle,
    // construction throw) already has the inverse in hand and cannot orphan the
    // timer. The timer is unref()'d, so even a leaked one cannot hold the
    // process open.
    let stopOccupancyHeartbeat: () => void = () => {};
    if (childConfig.cwd !== undefined) {
      void touchWorktreeOccupancy(childConfig.cwd);
      stopOccupancyHeartbeat = startWorktreeOccupancyHeartbeat(childConfig.cwd);
    }

    // Ordering constraint: the heartbeat armed above is disarmed by the settle
    // callback installed on the handle built below, so the guarded span has to
    // run from construction all the way through `active.set`. A throw anywhere
    // in between — the parent-stream read, the sink resolve, the handle
    // constructor — would otherwise return with the interval live and no handle
    // in existence to ever cancel it, and the tree would never be reaped again.
    let session: AgentSession;
    let handle: SubagentHandleImpl<T>;
    let effectiveAgentType: string | undefined;
    let effectiveResolvedAgentType: string | undefined;
    try {
      session = new AgentSession(childConfig);
      const parentInputStreamRef = options.parent.getInputStreamRef?.();
      const parentAbortSignal = options.parent.abortSignal;
      // Resolve sink: explicit option takes precedence, then ambient from AsyncLocalStorage
      const sink = this.progressSink ?? getCurrentSink();
      // Normalize empty-string render hints to undefined so the `??` fallbacks
      // engage. A caller passing `agentType: ''` or `parentId: ''` would
      // otherwise produce an empty Agent() label / empty agentContext anchor
      // rather than the intended fallback (idPrefix / parent.sessionId).
      effectiveAgentType = options.agentType?.trim() || undefined;
      effectiveResolvedAgentType = options.resolvedAgentType?.trim() || undefined;
      const effectiveParentId = options.parentId?.trim() || undefined;
      // Per-subagent conversation log — opt-in via AFK_SUBAGENT_LOG=1 (off by default).
      // Use sessionLabel (the directory key for /tasks) rather than
      // options.parent.sessionId (the SDK runtime ID): writer and reader must
      // agree on the same key so logs are found after the handle is evicted.
      // Falls back to options.parent.sessionId for backwards compatibility
      // when no sessionLabel was threaded through SubagentManagerOptions.
      const logSessionKey = this.sessionLabel ?? options.parent.sessionId;
      const logWriter = SubagentLogWriter.isEnabled() && logSessionKey
        ? new SubagentLogWriter(logSessionKey, id)
        : undefined;
      handle = new SubagentHandleImpl<T>(
        id,
        session,
        childController,
        this.abortGraph,
        options.outputSchema,
        // Hard wall-clock backstop, settled above as `effectiveTimeoutMs` and
        // SHARED with the child config's derived soft deadline so the two cannot
        // drift. Unchanged behaviour: this still aborts a wedged child on schedule.
        effectiveTimeoutMs,
        registry,
        () => {
          // Runs on every terminal outcome of the child — success, failure,
          // timeout, and abort — so it is the settle hook the heartbeat's
          // teardown belongs on.
          stopOccupancyHeartbeat();
          // Populate the completed cache BEFORE removing from active so that
          // the memory-first /tasks:view path can access the handle after
          // teardown. The result is a minimal stub — consumers only use
          // `handle` from the entry (see completed.get(id)?.handle).
          this.completed.add(id, handle as SubagentHandle, {
            id,
            status: handle._currentStatus === 'running' ? 'succeeded' : handle._currentStatus,
          });
          this.active.delete(id);
          this.abortGraph.dispose(id);
          void logWriter?.close();
          // Populate the completed cache so manager.get(id) keeps working
          // after the handle leaves the active map. All handle state fields
          // (_currentStatus, _currentTrace, _lastStopReason) are fully set
          // by run() before _onTerminal() fires.
          this.completed.recordHandle(
            id,
            handle as SubagentHandle<unknown>,
            handle._currentStatus,
            handle._currentTrace,
            handle._lastStopReason,
          );
        },
        parentInputStreamRef,
        parentAbortSignal,
        // agentType: explicit override → idPrefix fallback. Lets callers
        // (e.g. compose) supply a render-only label without altering idPrefix
        // which is also used for routing telemetry.
        effectiveAgentType ?? options.idPrefix,
        sink,
        // parentId: explicit override → parent session id fallback. Lets
        // callers (e.g. compose) anchor the renderer's nesting at the compose
        // tool_use_id rather than at the orchestrator session id.
        effectiveParentId ?? options.parent.sessionId,
        // traceWriter: child shares the parent's writer so its SubagentStop
        // hook decision lands in the same trace file. Contract:
        // docs/philosophy/afk-contract.md — "a child sub-agent inherits its
        // parent's witness." Resolved once above (per-fork config →
        // manager-level writer) so the handle's terminal lifecycle emits
        // pair with the 'started' emit below even when inheritance came
        // from the manager rather than the per-fork config.
        effectiveTraceWriter,
        // onSubagentSucceeded: propagate completion data to the parent
        // session's session_sealed rollup accumulators.
        this.onSubagentSucceededCb,
        // Progress-aware idle-watchdog window for the child's turn (see
        // SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS above). Explicit caller values win,
        // including `0` to disable the watchdog for this fork — `??` preserves that
        // precedence. The default is env-tunable via AFK_SUBAGENT_IDLE_TIMEOUT_MS
        // (resolveSubagentIdleTimeoutMs); an unset/invalid env value returns
        // SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS, so behaviour is unchanged when the var
        // is not set. Runs concurrently with the wall-clock budget above.
        options.config.idleTimeoutMs ?? resolveSubagentIdleTimeoutMs(),
      );
      if (logWriter) handle._logWriter = logWriter;
      this.active.set(id, handle as SubagentHandleImpl<unknown>);
    } catch (err) {
      // Construction or manager-wiring failed (invalid model, sync init
      // failure, a throwing parent-stream/sink read). Release the graph node
      // registered above so an orphan cannot accumulate across retry loops
      // (forge/farm), and disarm the occupancy heartbeat — there is no child
      // left to protect, and a live timer here would pin the worktree forever.
      stopOccupancyHeartbeat();
      this.abortGraph.dispose(id);
      throw err;
    }

    // Witness emit + routing telemetry: fires AFTER the handle is wired into
    // the manager's active map and the abort-graph. See ./subagent/fork-lifecycle.ts.
    const modelString = emitForkStarted({
      effectiveTraceWriter,
      id,
      parentSessionId: options.parent.sessionId,
      rootId: this.rootId,
      effectiveChildModel,
      childConfig,
      promptHead: options.promptHead,
      effectiveAgentType,
      effectiveResolvedAgentType,
    });
    await appendForkTelemetry({
      modelString,
      id,
      idPrefix: options.idPrefix,
      parentSessionId: options.parent.sessionId,
      effectiveResolvedAgentType,
    });

    return handle;
  }

  /** Cancel and remove a tracked subagent. Returns false if not found. */
  async kill(id: string): Promise<boolean> {
    const handle = this.active.get(id);
    if (!handle) return false;
    await handle.cancel();
    return true;
  }

  /** Cancel all running subagents. */
  async killAll(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((h) => h.cancel()));
  }

  /**
   * Cascade-abort the managed tree and wait (bounded) for every in-flight
   * child's terminal trace row to be handed to the writer.
   *
   * Contract: called by the session owner immediately before it seals the
   * shared trace writer. `killAll()` alone is not a substitute — this exists
   * to guarantee the *ordering* the writer's seal contract demands, and to
   * bound the wait so teardown cannot hang.
   *
   * Returns the number of children drained and whether the bound was hit, so
   * the caller can report a timeout instead of losing rows silently — the
   * silent loss is the entire bug this closes (#733).
   */
  async abortAllAndDrain(
    reason?: unknown,
    origin: AbortOrigin = 'user_signal',
    timeoutMs: number = SUBAGENT_DRAIN_TIMEOUT_MS,
    rearm: boolean = false,
  ): Promise<{ drained: number; timedOut: boolean }> {
    const inFlight = [...this.active.values()];
    if (inFlight.length === 0) {
      if (rearm && this.rootController.signal.aborted) this.rearmRoot();
      return { drained: 0, timedOut: false };
    }

    // Cascade first so descendants see the abort while we await their parents.
    this.abortGraph.abort(this.rootId, reason, origin);

    // Invariant: `handle.cancel()` emits the child's `cancelled` lifecycle row
    // synchronously before its own first await, so awaiting it here guarantees
    // the row has ENTERED writer.write() — and is therefore queued ahead of the
    // seal — even though the emit itself is fire-and-forget.
    let timedOut = false;
    const bound = new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs).unref(),
    );
    await Promise.race([
      Promise.allSettled(inFlight.map((h) => h.cancel())),
      bound,
    ]);
    if (timedOut) {
      console.warn(
        `[SubagentManager] abortAllAndDrain: ${inFlight.length} child(ren) did not settle ` +
          `within ${timeoutMs}ms — sealing anyway; their terminal rows may be missing`,
      );
    }
    // `/clear` ends one session lifecycle but the manager itself survives.
    // AbortSignals are terminal, so replace the root controller before the
    // rebuilt session can dispatch children. The graph node is retained to
    // preserve manager-level listeners and child-link bookkeeping.
    if (rearm) this.rearmRoot();
    return { drained: inFlight.length, timedOut };
  }

  private rearmRoot(): void {
    this.rootController = new AbortController();
    this.abortGraph.rearm(this.rootId, this.rootController);
    // The constructor's listener follows `this.rootController`, but an
    // external parent may have aborted in the narrow interval before rearm.
    if (this.parentAbortSignal?.aborted) {
      this.rootController.abort(this.parentAbortSignal.reason);
    }
  }

  /**
   * Tear down every still-active subagent (release sessions + fire
   * SubagentStop) without flagging them as aborted. Handles that already
   * completed a run have self-removed from the active map via `onTerminal`,
   * so those must be torn down per-handle by the caller — this method covers
   * forks that were never run or were still running at cleanup time.
   *
   * Companion to {@link killAll}: `killAll` treats the fleet as being
   * interrupted; `teardownAll` treats it as having finished.
   */
  async teardownAll(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((h) => h.teardown()));
  }
}
