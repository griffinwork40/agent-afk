/**
 * `abortAllAndDrain` — bounded cascade-abort + drain for SubagentManager.
 * Split out of `subagent.ts` (file-size ceiling, #3481).
 *
 * Extracted as a free function so `SubagentManager.abortAllAndDrain` becomes
 * a one-line delegation and the drain logic is testable in isolation.
 *
 * @module agent/subagent.drain
 */

import type { AbortOrigin } from './trace/index.js';
import type { AbortGraph } from './abort-graph.js';
import { SUBAGENT_DRAIN_TIMEOUT_MS } from './subagent/constants.js';

/** Minimal handle shape the drain function needs. */
export interface DrainHandle {
  cancel(): Promise<void>;
}

/**
 * Cascade-abort a set of in-flight subagent handles and wait (bounded) for
 * every child's terminal trace row to reach the writer.
 *
 * Contract: called by `SubagentManager.abortAllAndDrain` immediately before
 * the session owner seals the shared trace writer. `killAll()` alone is not
 * a substitute — this guarantees ordering so terminal rows queue ahead of
 * the seal, and bounds the wait so teardown cannot hang.
 *
 * @param active      Live handles; iterated once for abort + once for drain.
 * @param abortGraph  The manager's AbortGraph; cascade fires through it.
 * @param rootId      The manager's root node id in the AbortGraph.
 * @param reason      Forwarded to every cascade victim's AbortController.
 * @param origin      Witness-layer classification of who initiated the abort.
 * @param timeoutMs   Drain timeout; defaults to SUBAGENT_DRAIN_TIMEOUT_MS.
 * @param rearm       When true, replace the root controller after draining.
 * @param doRearm     Callback to `SubagentManager.rearmRoot()` (private, so
 *                    passed in as a closure to avoid exposing it publicly).
 */
export async function abortAllAndDrainImpl(
  active: ReadonlyMap<string, DrainHandle>,
  abortGraph: AbortGraph,
  rootId: string,
  reason: unknown,
  origin: AbortOrigin,
  timeoutMs: number,
  rearm: boolean,
  doRearm: () => void,
): Promise<{ drained: number; timedOut: boolean }> {
  const inFlight = [...active.values()];
  if (inFlight.length === 0) {
    if (rearm) doRearm();
    return { drained: 0, timedOut: false };
  }

  // Cascade first so descendants see the abort while we await their parents.
  abortGraph.abort(rootId, reason, origin);

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
  if (rearm) doRearm();
  return { drained: inFlight.length, timedOut };
}

export { SUBAGENT_DRAIN_TIMEOUT_MS };
