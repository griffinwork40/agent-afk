/**
 * Session-shutdown coordination, extracted from {@link AgentSession}.
 *
 * Owns the `dispatchSessionEndOnce` procedure and the guard flag that
 * ensures it runs exactly once per SDK lifecycle cycle. Callers
 * (`close()`, `reset()`, `onAbort()`, and the `pullInitialization` error
 * path) each obtain the same once-gate through
 * {@link SessionShutdown.dispatchOnce}.
 *
 * No back-reference to {@link AgentSession}: all external state is
 * accessed through the {@link ShutdownDeps} context bag.
 *
 * @module agent/session/session-shutdown
 */

import type { TraceWriter } from '../trace/writer.js';
import { dispatchSessionEnd } from './hooks-dispatch.js';
import { emitClosureEvent, sealTraceWriter, type SealTraceInput } from './closure-emitter.js';
import type { AccountingAccumulator } from './accounting-accumulator.js';
import type { HookRegistry } from '../hooks.js';
import type { AgentConfig } from '../types.js';

/** Context bag threaded into {@link SessionShutdown} at construction. */
export interface ShutdownDeps {
  getConfig: () => AgentConfig;
  getAbortController: () => AbortController;
  getHookRegistry: () => HookRegistry | undefined;
  accounting: AccountingAccumulator;
  getTurnCount: () => number;
  getSessionId: () => string | undefined;
  /** The seal-capable TraceWriter — undefined when this session is not the owner. */
  ownedTraceWriter: TraceWriter | undefined;
  /** Whether this session owns the trace seal (second-arg ownership check). */
  ownsTraceSeal: boolean;
}

/**
 * Coordinates the once-only session-end dispatch: closure-event emission,
 * optional trace-seal, and SessionEnd hook dispatch.
 */
export class SessionShutdown {
  private dispatched = false;
  private readonly deps: ShutdownDeps;

  constructor(deps: ShutdownDeps) {
    this.deps = deps;
  }

  /**
   * Reset the dispatched flag for a new SDK lifecycle cycle (after `/clear`).
   * Must be called before the new cycle begins so SessionEnd fires once per
   * cycle, not once per session-object lifetime.
   */
  reset(): void {
    this.dispatched = false;
  }

  /**
   * Run the full session-end sequence, guarded by a once-only flag.
   *
   * Ordering (externally governed by writer contract — see Invariant below):
   *   1. Drain in-flight subagents (bounded, never rethrows).
   *   2. Emit the `closure` trace event.
   *   3. Seal the trace writer (top-level sessions only).
   *   4. Dispatch the SessionEnd hook.
   *
   * Both (2) and (3) swallow writer errors so a broken sink never masks the
   * real session-end reason from downstream observers.
   *
   * Invariant: in-flight children must be cascade-aborted and drained BEFORE
   * the writer is sealed; `seal()` flips `sealed = true` synchronously and
   * `write()` rejects on a sealed writer, so a terminal row whose `write()`
   * has not been entered by the time seal begins is lost silently (#733).
   * The drain is bounded and never rethrows — a wedged child must not
   * convert "parent finished" into a hang.
   *
   * Invariant: sealing BEFORE the SessionEnd hook fires so a hook-thrown
   * exception cannot leave the trace `sealed-crashed` on the normal close
   * path (a hook crash would surface as a separate `hook_decision: block`
   * record, not erase the seal).
   */
  async dispatchOnce(reason: string): Promise<void> {
    if (this.dispatched) return;
    this.dispatched = true;

    const {
      getConfig,
      getAbortController,
      getHookRegistry,
      accounting,
      getTurnCount,
      getSessionId,
      ownsTraceSeal,
      ownedTraceWriter,
    } = this.deps;
    const config = getConfig();

    if (config.drainSubagents !== undefined) {
      await config.drainSubagents(reason).catch(() => {});
    }

    const signals = accounting.closureSignals(getAbortController().signal, reason);
    const acct = accounting.snapshot();

    await emitClosureEvent(config.traceWriter, {
      ...signals,
      finalTurnCount: getTurnCount(),
      finalCostUsd: acct.sessionRunningCostUsd,
      runningTokens: acct.sessionRunningTokens,
    }).catch(() => {});

    // Invariant: only a session explicitly given the separate owner capability
    // (the second constructor arg to AgentSession) may seal the shared
    // TraceWriter. Fork configs inherit only the TraceSink — the type split
    // prevents promotion. seal() is a one-shot hard gate: a child sealing
    // first would silently truncate all later records.
    // Subagents still emit their own `closure` record above; only the seal
    // is gated. If the top-level never calls close(), the process-exit
    // backstop still seals.
    if (ownsTraceSeal) {
      const sealInput: SealTraceInput = {
        ...signals,
        finalTurnCount: getTurnCount(),
        finalCostUsd: acct.sessionRunningCostUsd,
        subagentCompletedCount: acct.subagentCompletedCount,
        subagentRunningTokens: acct.subagentRunningTokens,
        subagentRunningCostUsd: acct.subagentRunningCostUsd,
      };
      await sealTraceWriter(ownedTraceWriter, sealInput).catch(() => {});
    }

    await dispatchSessionEnd(
      getHookRegistry(),
      {
        event: 'SessionEnd',
        sessionId: getSessionId(),
        reason,
        // Subagent provenance: lets session-scoped SessionEnd hooks (e.g.
        // the memory writer) skip forked children, which inherit this registry.
        parentSessionId: config.parentSessionId,
        // Authoritative trace path for the run-receipt hook. The witness
        // dir is keyed by the writer's session label (random on the one-shot
        // path), not by sessionId, so a hook cannot reconstruct it.
        ...(config.traceWriter
          ? { tracePath: config.traceWriter.getTracePath() }
          : {}),
        // Effective working directory for the session — threaded so
        // session-end hooks (e.g. the yield probe) run git/gh against the
        // session's repo rather than process.cwd().
        ...(config.cwd ? { cwd: config.cwd } : {}),
      },
      // Invariant: skip traceWriter when this session owns the seal (step 3
      // above) — the writer is sealed, so the hook_decision write would throw.
      config.traceWriter && !ownsTraceSeal ? { traceWriter: config.traceWriter } : {},
    );
  }
}
