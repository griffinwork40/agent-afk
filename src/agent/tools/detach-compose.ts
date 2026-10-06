/**
 * Compose-specific detach helpers for the Ctrl+B contract (#2542).
 *
 * Mirrors `detach-bash.ts` but for the `compose` tool. The compose executor
 * calls {@link applyComposeDetach} when `detachRegistry` is injected into its
 * context, enabling Ctrl+B to free the model's turn while the DAG keeps
 * running.
 *
 * Flow:
 *   1. Early in `execute()`, before `runSubagentDAG` is awaited, the executor
 *      calls `applyComposeDetach(...)`. That function:
 *        a. Registers the call with the detach registry (returns a token).
 *        b. Installs a once-listener on `token.detachSignal`.
 *   2. If Ctrl+B fires: the listener calls the provided `onDetach` callback,
 *      which the compose executor defines as a closure over its local state.
 *   3. The executor returns `token.detachResult(label)` immediately (freeing
 *      the model's turn). The DAG Promise keeps running via the session's own
 *      AbortSignal — `call.signal` is not the DAG's governing signal.
 *   4. When the DAG Promise settles, the executor calls `token.deliver()` with
 *      a {@link DetachedToolResult}. The registry emits 'settled'; the REPL
 *      notifier injects the result into the next turn.
 *
 * Why the DAG keeps running after detach:
 *   `ComposeExecutor.execute()` passes `ctx.parentSession.abortSignal` (the
 *   session-level signal) as `parentAbortSignal` to SubagentManager — NOT
 *   `call.signal` (the per-turn signal). So the DAG is already anchored to
 *   the session's lifetime, not the turn's. Returning the detach placeholder
 *   from `execute()` frees the turn without aborting the DAG. Session teardown
 *   aborts the DAG through its own signal (Invariant:D3).
 *
 * Provider parity (Invariant:D2): both provider loops call
 * `dispatcher.execute()` → `executeCompose()` → `composeExecutor.execute()`.
 * The detach contract lives in `CoreExecDeps.detachRegistry` (shared across
 * providers) and inside the executor — no provider-specific code path.
 *
 * @module agent/tools/detach-compose
 */

import type { DetachableToolRegistry, DetachToken, DetachedToolResult } from './detach-registry.js';
import { partialNodeFlag } from './compose-executor.partial.js';

/**
 * Maximum nodes to list in the detach label before collapsing to "N nodes".
 */
const MAX_LABEL_NODES = 3;

/**
 * Build the human-readable label for a detached compose call.
 * Shows up to MAX_LABEL_NODES node ids, then "… +N more".
 */
export function composeDetachLabel(nodeIds: readonly string[]): string {
  if (nodeIds.length === 0) return 'compose [0 nodes]';
  const shown = nodeIds.slice(0, MAX_LABEL_NODES);
  const remainder = nodeIds.length - shown.length;
  const preview = shown.join(', ');
  return remainder > 0
    ? `compose [${preview} … +${remainder} more]`
    : `compose [${preview}]`;
}

/**
 * Build the {@link DetachedToolResult} delivered to the registry's 'settled'
 * notifier once the detached DAG actually finishes.
 *
 * Status is 'failed' when `failed` is true — meaning either the DAG threw
 * entirely (caught by the `.catch` continuation), the session was aborted, or
 * one or more DAG nodes failed. This mirrors the non-detached path, which
 * returns `isError: result.failed.length > 0` (see compose-executor.ts). Node
 * failures are surfaced in the formatted output text; the status flag signals
 * the same "at least one node did not succeed" condition to downstream consumers.
 *
 * @param toolUseId   Stable id from the provider's tool-use block.
 * @param label       Human-readable summary (from {@link composeDetachLabel}).
 * @param output      Formatted DAG result text (from formatDAGResult) or error message.
 * @param failed      Whether the compose call itself failed (threw or was aborted).
 * @param startedAt   Epoch ms when the compose call started.
 */
export function buildComposeDelivery(
  toolUseId: string,
  label: string,
  output: string,
  failed: boolean,
  startedAt: number,
): DetachedToolResult {
  return {
    toolUseId,
    label,
    status: failed ? 'failed' : 'completed',
    output,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Wire the detach contract into an in-flight compose execution.
 *
 * Registers the call with the registry and installs a one-time 'abort'
 * listener on the returned token's `detachSignal`. When the signal fires,
 * `token.notifyDetached()` is called and then `onDetach(token, label)` is
 * invoked so the compose executor (which owns the local resolve state) can
 * complete the detach without this helper closing over those variables.
 *
 * @param registry    The session's detach registry.
 * @param toolUseId   Stable id from the provider's tool-use block.
 * @param nodeIds     DAG node ids used to build the label.
 * @param onDetach    Called when detach fires — executor's detach body.
 * @returns The registered token.
 */
export function applyComposeDetach(
  registry: DetachableToolRegistry,
  toolUseId: string,
  nodeIds: readonly string[],
  onDetach: (token: DetachToken, label: string) => void,
): DetachToken {
  const label = composeDetachLabel(nodeIds);
  const token = registry.register(toolUseId);
  // Ordered-operation constraint: the 'abort' listener must be installed
  // BEFORE control returns to the caller so no microtask tick between
  // register() and addEventListener can lose a detachAll() that fires
  // synchronously in tests.
  token.detachSignal.addEventListener('abort', () => {
    if (!token.shouldDetach()) return; // normal settle already deregistered
    token.notifyDetached();
    onDetach(token, label);
  }, { once: true });
  return token;
}

// ---------------------------------------------------------------------------
// DAG race helper
// ---------------------------------------------------------------------------

import type { DAGRunResult } from '../dag.js';
import type { ToolResult } from './types.js';
import { errorMessage } from '../../utils/errors.js';
import { debugLog } from '../../utils/debug.js';

/**
 * Parameters for {@link raceComposeDetach}.
 */
export interface ComposeDetachRaceParams {
  /** The running DAG Promise. Not yet awaited — we race it here. */
  dagPromise: Promise<DAGRunResult>;
  /** DAG node ids used to build the detach label via composeDetachLabel. */
  nodeIds: readonly string[];
  /** Stable tool-use id for this compose call. */
  toolUseId: string;
  /** Pre-failed nodes (attachment errors) to merge into the DAG result. */
  attachmentErrors: Array<{ id: string; error: Error }>;
  /** Epoch ms when execute() started (for durationMs). */
  startedAt: number;
  /**
   * Format function from compose-executor scope — avoids importing
   * formatDAGResult (private to that module). Takes the merged DAGRunResult
   * and returns the model-facing content string.
   */
  formatResult: (result: DAGRunResult) => string;
  /**
   * Manager teardown — called in the detach continuation's finally clause so
   * SubagentManager is torn down even on the out-of-band delivery path.
   */
  teardown: () => Promise<void>;
  /** Detach registry — registers the call and used to deregister on normal path. */
  detachRegistry: DetachableToolRegistry;
  /**
   * Called when the detach signal fires (Ctrl+B). The executor uses this to
   * update its local `detachedRef.value` flag so the `finally` clause knows
   * to skip teardownAll (the continuation owns it on the detach path).
   */
  onDetach: () => void;
}

/**
 * Outcome returned by {@link raceComposeDetach}.
 */
export type ComposeDetachRaceOutcome =
  | { kind: 'detached'; placeholder: ToolResult }
  | { kind: 'normal'; dagResult: DAGRunResult };

/**
 * Race the compose DAG against the detach-trigger Promise.
 *
 * Registers the call with the registry, then races the DAG against the detach
 * signal. If the DAG finishes first, deregisters the token and returns the
 * result. If Ctrl+B fires first, wires a fire-and-forget continuation for
 * out-of-band delivery and returns the detach placeholder immediately.
 *
 * Pass `detachRegistry: undefined` to skip detach wiring entirely (no-op
 * for headless surfaces). Callers on the REPL surface always pass it.
 *
 * Extracted from `ComposeExecutor.execute()` to keep it within the
 * funcsize baseline (the inline wiring grew it above the 350-code-line ceiling).
 */
export async function raceComposeDetach(
  p: ComposeDetachRaceParams,
): Promise<ComposeDetachRaceOutcome> {
  const label = composeDetachLabel(p.nodeIds);
  // Register BEFORE constructing the race Promise so no tick between
  // register() and the abort listener can lose a synchronous detachAll().
  const token = applyComposeDetach(p.detachRegistry, p.toolUseId, p.nodeIds, () => {
    p.onDetach();
  });
  // Ordered-operation constraint: construct the detach Promise BEFORE the race
  // so the second 'abort' listener (which resolves the Promise) is in place
  // when detachAll() fires. applyComposeDetach installed the first listener;
  // this second one resolves the race leg without coupling to that callback.
  const detachPromise = new Promise<ToolResult>((resolve) => {
    token.detachSignal.addEventListener('abort', () => {
      // Defensive shouldDetach() guard — mirrors applyComposeDetach's listener.
      // Prevents resolve() from firing if the token was already settled by the
      // normal (DAG-finished-first) path and its abort was never triggered.
      if (!token.shouldDetach()) return;
      resolve(token.detachResult(label));
    }, { once: true });
  });

  const winner = await Promise.race([
    p.dagPromise.then((r) => ({ kind: 'dag' as const, dagResult: r })),
    detachPromise.then((r) => ({ kind: 'detach' as const, result: r })),
  ]);

  if (winner.kind === 'detach') {
    // Turn freed by Ctrl+B. Continuation owns delivery + teardown.
    // Fix #2 analogue: deregister is NOT called here — token.deliver() does it.
    const { toolUseId, attachmentErrors, startedAt } = p;
    void p.dagPromise
      .then((r) => {
        const merged = attachmentErrors.length > 0
          ? { ...r, failed: [...attachmentErrors, ...r.failed] } : r;
        const failed = merged.failed.length > 0;
        // Carry the soft-deadline partial flag (#2970) so the detached
        // delivery matches the non-detached tool result. Note: no production
        // subscriber consumes the registry's 'settled' event yet, so this flag
        // reaches the sidecar only once detached delivery is wired.
        token.deliver({
          ...buildComposeDelivery(toolUseId, label, p.formatResult(merged), failed, startedAt),
          ...partialNodeFlag(merged.partial),
        });
      })
      .catch((err: unknown) => {
        const msg = errorMessage(err);
        token.deliver(buildComposeDelivery(toolUseId, label, `Compose execution error: ${msg}`, true, startedAt));
      })
      .finally(() => { void p.teardown().catch((err: unknown) => { debugLog(`[compose-detach] teardown error: ${String(err)}`); }); });
    return { kind: 'detached', placeholder: winner.result };
  }

  // DAG finished before detach fired — normal path. Deregister the token
  // so hasDetachable() returns false (Fix #2 analogue for compose).
  p.detachRegistry.deregister(p.toolUseId);
  return { kind: 'normal', dagResult: winner.dagResult };
}

/** Re-export registry type for use in the dispatcher without importing the full module. */
export type { DetachableToolRegistry };
