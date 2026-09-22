/**
 * Factory for the per-run idempotent `_onTerminal` callback attached to every forked
 * subagent handle.
 *
 * The callback runs on every terminal outcome (success, failure, timeout,
 * abort). It: disarms the occupancy heartbeat, emits a subagent_lifecycle
 * witness event into the parent output stream, removes the handle from the
 * active map, disposes the abort-graph node, closes the log writer, and
 * records the handle in the completed cache.
 *
 * A `{ current }` ref holds the forward-reference to the handle so the
 * callback can be constructed before `SubagentHandleImpl` is instantiated.
 *
 * @module agent/subagent/fork-terminal-hook
 */

import type { AbortGraph } from '../abort-graph.js';
import type { OutputEvent } from '../types/session-types.js';
import type { SubagentHandle, SubagentHandleImpl } from './handle.js';
import type { SubagentTrace, SubagentStatus } from './result.js';

export interface ForkTerminalDeps {
  id: string;
  stopOccupancyHeartbeat: () => void;
  getOutputEventSink: () => ((event: OutputEvent) => void) | undefined;
  activeMap: Map<string, unknown>;
  abortGraph: AbortGraph;
  logWriter: { close(): void } | undefined;
  completedCache: {
    recordHandle(
      id: string,
      handle: SubagentHandle<unknown>,
      status: SubagentStatus,
      trace: SubagentTrace,
      stopReason: string | undefined,
    ): void;
  };
}

/**
 * Create a per-run idempotent `_onTerminal` callback for a forked subagent
 * handle. A handle may be run more than once, so deduplication is keyed by the
 * trace object created for each run rather than by the lifetime of the handle.
 *
 * Pass a `{ current }` ref whose `.current` is assigned the handle immediately
 * after `SubagentHandleImpl` is constructed — before the first async tick that
 * could fire the callback.
 */
export function makeForkTerminalHook<T>(
  deps: ForkTerminalDeps,
  ref: { current: SubagentHandleImpl<T> | undefined },
): () => void {
  const completedRuns = new WeakSet<SubagentTrace>();
  return () => {
    const handle = ref.current!;
    const trace = handle._currentTrace;
    if (completedRuns.has(trace)) return;
    completedRuns.add(trace);

    deps.stopOccupancyHeartbeat();

    // handle._currentStatus is already set before _onTerminal fires.
    const rawStatus = handle._currentStatus;
    const terminalStatus: 'succeeded' | 'failed' | 'cancelled' =
      rawStatus === 'succeeded' || rawStatus === 'failed' || rawStatus === 'cancelled'
        ? rawStatus
        : 'succeeded';
    deps.getOutputEventSink()?.({
      type: 'subagent_lifecycle',
      subagentId: deps.id,
      status: terminalStatus,
      ...(handle._lastDurationMs !== undefined ? { durationMs: handle._lastDurationMs } : {}),
      ...(handle._currentTrace.turnCount > 0 ? { turnCount: handle._currentTrace.turnCount } : {}),
      ...(handle._lastStopReason !== undefined ? { stopReason: handle._lastStopReason } : {}),
    });
    deps.activeMap.delete(deps.id);
    deps.abortGraph.dispose(deps.id);
    if (deps.logWriter) void deps.logWriter.close();
    // Populate the completed cache so manager.get(id) keeps working after the
    // handle leaves the active map. All handle state fields are fully set by
    // run() before _onTerminal() fires.
    deps.completedCache.recordHandle(
      deps.id,
      handle as SubagentHandle<unknown>,
      handle._currentStatus,
      handle._currentTrace,
      handle._lastStopReason,
    );
  };
}
