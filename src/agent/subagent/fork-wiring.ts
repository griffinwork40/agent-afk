/**
 * Fork-time wiring phases extracted from `SubagentManager.forkSubagent`
 * (#1865, function-size ceiling). Each helper takes EXPLICIT parameters — no
 * closures over the manager's locals — and runs exactly the statements it
 * replaced, in the same order, so the hot fork path's side-effect ordering is
 * unchanged:
 *
 * - {@link armForkOccupancy}: worktree occupancy touch + heartbeat.
 * - {@link constructForkHandle}: progress/workspace wiring, child session and
 *   handle construction, registration into the active map.
 * - {@link rollbackFailedFork}: the construction-failure cleanup path.
 *
 * @module agent/subagent/fork-wiring
 */

import type { AbortGraph } from '../abort-graph.js';
import type { HookRegistry } from '../hooks.js';
import { AgentSession } from '../session.js';
import type { AgentConfig } from '../types.js';
import type { SubagentProgressSink, OutputEvent } from '../types/session-types.js';
import type { TraceSink } from '../trace/index.js';
import type { WorkspaceStore } from '../workspace/workspace-store.js';
import { dispatchSubagentStop } from '../subagent-hooks.js';
import { getCurrentSink } from '../_lib/skill-sink-channel.js';
import { touchWorktreeOccupancy, startWorktreeOccupancyHeartbeat } from '../worktree/worktree-occupancy.js';
import { errorMessage } from '../../utils/errors.js';
import { wrapTerminalWithRelease, type SpawnReceipt } from './fork-budget.js';
import { SubagentHandleImpl } from './handle.js';
import { SubagentLogWriter } from './log.js';
import { wireProgressEvents } from './fork-progress-events.js';
import { wireWorkspaceSubscriptions } from './workspace-subscription-wiring.js';
import { makeForkTerminalHook, type ForkTerminalDeps } from './fork-terminal-hook.js';
import { resolveSubagentIdleTimeoutMs } from './constants.js';
import type { ForkSubagentOptions } from './fork-types.js';
import type { SubagentTrace } from './result.js';

/**
 * Arm worktree occupancy for a fork's cwd and return the heartbeat's stop
 * handle (a no-op when `cwd` is undefined).
 *
 * Invariant: subagents never write presence files (top-level-only by design —
 * presence.ts), so the worktree sweep's live-session guard cannot see a fork
 * occupying a worktree. Refresh the worktree's meta (pid + createdAt) instead,
 * resetting the sweep's age clock and PID liveness. Fire-and-forget: the
 * helper swallows all errors and no-ops for cwds outside `.afk-worktrees/`, so
 * it can never delay or fail the fork. Single wiring point — agent/skill/
 * compose/farm dispatches all converge here, whether cwd came per-call or via
 * manager inheritance.
 *
 * Ordering constraint: one touch only protects the tree for the sweep's
 * MIN_EMPTY_AGE_MS (1h), after which a still-running child ages back into the
 * `empty` verdict and is force-removed mid-flight (#759). So arm a heartbeat
 * alongside the initial touch, and the caller captures its stop handle BEFORE
 * the session is constructed — so every exit path (settle, construction throw)
 * already has the inverse in hand and cannot orphan the timer. The timer is
 * unref()'d, so even a leaked one cannot hold the process open.
 */
export function armForkOccupancy(cwd: string | undefined): () => void {
  if (cwd === undefined) return () => {};
  void touchWorktreeOccupancy(cwd);
  return startWorktreeOccupancyHeartbeat(cwd);
}

export interface ConstructForkHandleArgs<T> {
  options: ForkSubagentOptions<T>;
  id: string;
  childConfig: AgentConfig;
  childController: AbortController;
  effectiveTimeoutMs: number;
  registry: HookRegistry | undefined;
  effectiveTraceWriter: TraceSink | undefined;
  budgetReceipt: SpawnReceipt | undefined;
  stopOccupancyHeartbeat: () => void;
  workspaceStore: WorkspaceStore | undefined;
  /** Manager-level progress sink; falls back to the ambient AsyncLocalStorage sink. */
  progressSink: SubagentProgressSink | undefined;
  sessionLabel: string | undefined;
  getOutputEventSink: () => ((event: OutputEvent) => void) | undefined;
  activeMap: Map<string, SubagentHandleImpl<unknown>>;
  abortGraph: AbortGraph;
  completedCache: ForkTerminalDeps['completedCache'];
  onSubagentSucceeded:
    | ((usage: SubagentTrace['usage'], costUsd: number | undefined) => void)
    | undefined;
}

export interface ConstructedFork<T> {
  handle: SubagentHandleImpl<T>;
  effectiveAgentType: string | undefined;
  effectiveResolvedAgentType: string | undefined;
}

/**
 * Wire progress events + workspace subscriptions, construct the child session
 * and its handle, and register the handle in `activeMap`. Synchronous — the
 * caller wraps it in the guarded span whose catch runs {@link rollbackFailedFork}.
 */
export function constructForkHandle<T>(args: ConstructForkHandleArgs<T>): ConstructedFork<T> {
  const { options, id, childConfig, childController, effectiveTimeoutMs, registry, effectiveTraceWriter } = args;

  // Progress-events opt-in — mutates childConfig.customTools in place when enabled.
  const bindProgressHandle = wireProgressEvents(childConfig, options.progressEvents, options.parent.getInputStreamRef?.(), options.parent.abortSignal);

  // Workspace subscriptions (Pillar 3): two-phase init mirrors progress events.
  const wsSubs = wireWorkspaceSubscriptions(args.workspaceStore, id, effectiveTraceWriter, childConfig.provider as never);

  // Ordering constraint: the heartbeat armed by the caller is disarmed by the
  // settle callback installed on the handle built below, so the guarded span
  // has to run from construction all the way through `active.set`. A throw
  // anywhere in between — the parent-stream read, the sink resolve, the handle
  // constructor — would otherwise return with the interval live and no handle
  // in existence to ever cancel it, and the tree would never be reaped again.
  const session = new AgentSession(childConfig);
  const parentInputStreamRef = options.parent.getInputStreamRef?.();
  const parentAbortSignal = options.parent.abortSignal;
  // Resolve sink: explicit option takes precedence, then ambient from AsyncLocalStorage
  const sink = args.progressSink ?? getCurrentSink();
  // Normalize empty-string render hints to undefined so the `??` fallbacks
  // engage. A caller passing `agentType: ''` or `parentId: ''` would
  // otherwise produce an empty Agent() label / empty agentContext anchor
  // rather than the intended fallback (idPrefix / parent.sessionId).
  const effectiveAgentType = options.agentType?.trim() || undefined;
  const effectiveResolvedAgentType = options.resolvedAgentType?.trim() || undefined;
  const effectiveParentId = options.parentId?.trim() || undefined;
  // Per-subagent conversation log — opt-in via AFK_SUBAGENT_LOG=1 (off by default).
  // Use sessionLabel (the directory key for /tasks) rather than
  // options.parent.sessionId (the SDK runtime ID): writer and reader must
  // agree on the same key so logs are found after the handle is evicted.
  // Falls back to options.parent.sessionId for backwards compatibility
  // when no sessionLabel was threaded through SubagentManagerOptions.
  const logSessionKey = args.sessionLabel ?? options.parent.sessionId;
  const logWriter = SubagentLogWriter.isEnabled() && logSessionKey
    ? new SubagentLogWriter(logSessionKey, id)
    : undefined;
  // Forward-reference ref: assigned immediately after handle construction,
  // before any async tick that could fire _onTerminal.
  const handleRef: { current: SubagentHandleImpl<T> | undefined } = { current: undefined };
  const onTerminal = wrapTerminalWithRelease(
    makeForkTerminalHook<T>(
      {
        id,
        stopOccupancyHeartbeat: args.stopOccupancyHeartbeat,
        // Resolve at termination time so setOutputEventSink() retains its
        // documented late-binding/replacement semantics for in-flight forks.
        getOutputEventSink: args.getOutputEventSink,
        activeMap: args.activeMap,
        abortGraph: args.abortGraph,
        logWriter,
        completedCache: args.completedCache,
      },
      handleRef,
    ),
    args.budgetReceipt,
  );
  const handle = new SubagentHandleImpl<T>(
    id,
    session,
    childController,
    args.abortGraph,
    options.outputSchema,
    // Hard wall-clock backstop, settled by the caller as `effectiveTimeoutMs`
    // and SHARED with the child config's derived soft deadline so the two
    // cannot drift. Unchanged behaviour: this still aborts a wedged child on schedule.
    effectiveTimeoutMs,
    registry,
    onTerminal,
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
    // parent's witness." Resolved once by the caller (per-fork config →
    // manager-level writer) so the handle's terminal lifecycle emits
    // pair with the 'started' emit even when inheritance came
    // from the manager rather than the per-fork config.
    effectiveTraceWriter,
    // onSubagentSucceeded: propagate completion data to the parent
    // session's session_sealed rollup accumulators.
    args.onSubagentSucceeded,
    // Progress-aware idle-watchdog window for the child's turn (see
    // SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS). Explicit caller values win, including
    // `0` to disable the watchdog for this fork — `??` preserves that
    // precedence. The default is env-tunable via AFK_SUBAGENT_IDLE_TIMEOUT_MS
    // (resolveSubagentIdleTimeoutMs); an unset/invalid env value returns
    // SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS, so behaviour is unchanged when the var
    // is not set. Runs concurrently with the wall-clock budget.
    options.config.idleTimeoutMs ?? resolveSubagentIdleTimeoutMs(),
  );
  handleRef.current = handle;
  if (logWriter) handle._logWriter = logWriter;
  bindProgressHandle(handle as SubagentHandleImpl<unknown>);
  wsSubs.bindHandle(handle as SubagentHandleImpl<unknown>);
  args.activeMap.set(id, handle as SubagentHandleImpl<unknown>);
  return { handle, effectiveAgentType, effectiveResolvedAgentType };
}

export interface RollbackFailedForkArgs {
  err: unknown;
  id: string;
  stopOccupancyHeartbeat: () => void;
  budgetReceipt: SpawnReceipt | undefined;
  abortGraph: AbortGraph;
  registry: HookRegistry | undefined;
  rootSignal: AbortSignal;
  effectiveTraceWriter: TraceSink | undefined;
}

/**
 * Undo a fork whose guarded construction span threw. Does NOT re-throw — the
 * caller re-throws `err` after this returns.
 *
 * Invariant: a throw anywhere in the guarded span (resolveReadScope,
 * assembleChildConfig, heartbeat setup, wireWorkspaceSubscriptions,
 * AgentSession construction, or handle wiring) reaches here. Four invariants
 * to restore:
 *
 * 1. Disarm the occupancy heartbeat — there is no child left to protect, and
 *    a live timer would pin the worktree's sweep clock forever. The stub no-op
 *    fires harmlessly when the throw happened before the heartbeat was armed.
 *
 * 2. Dispose the abort-graph node — SubagentStart has already been emitted, so
 *    the node is live. Leaking it across retry loops (forge/farm) accumulates
 *    orphan nodes and eventually corrupts cascade-abort semantics.
 *
 * 3. Emit SubagentStop for symmetry — SubagentStart was dispatched, so any
 *    hook observing SubagentStart expects a matching SubagentStop. Non-
 *    blocking: errors are swallowed by dispatchSubagentStop itself.
 *
 * 4. Roll back the delegation budget slot — the child never ran, so a
 *    permanent slot consumption would silently exhaust maxTotalAgents across
 *    forge/farm retry loops. `budgetReceipt` is undefined when no budget is
 *    configured, so the rollback is a no-op in the common case.
 */
export function rollbackFailedFork(args: RollbackFailedForkArgs): void {
  const { err, id, registry, effectiveTraceWriter } = args;
  args.stopOccupancyHeartbeat();
  args.budgetReceipt?.rollback();
  args.abortGraph.dispose(id);
  if (registry) {
    void dispatchSubagentStop(
      registry,
      {
        event: 'SubagentStop',
        subagentId: id,
        status: 'failed',
        reason: errorMessage(err),
      },
      {
        signal: args.rootSignal,
        ...(effectiveTraceWriter ? { traceWriter: effectiveTraceWriter } : {}),
      },
    );
  }
}
