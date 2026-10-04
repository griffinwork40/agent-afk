/**
 * Session-layer Stop dispatch for one completed top-level turn.
 *
 * Extracted from turn-stream-runner.ts (one whole concern: "what happens
 * when a top-level turn ends") so the runner stays under the file-size
 * ceiling and the enrichment logic is unit-testable without a provider.
 *
 * @module agent/session/turn-stream-runner.stop
 */

import type { AgentConfig } from '../types.js';
import type { Message } from '../types.js';
import type { StopWiring } from '../types/session-types.js';
import { classifyDoneEvidence, doneHasCorroboratingEvidence, type ToolEventMin } from '../done-evidence.js';
import { parseTerminalState } from '../terminal-state.js';
import { dispatchStopHook } from './hooks-dispatch.js';

export interface TurnStopParams {
  config: AgentConfig;
  /** Read at call time, never cached: surfaces wire it after construction. */
  wiring: StopWiring | undefined;
  sessionId: string | undefined;
  signal: AbortSignal;
  conversationHistory: readonly Message[];
  /** This turn's tool events, with real inputs (stream-consumer accumulator). */
  toolEvents: readonly ToolEventMin[];
}

/** The text of the most recent assistant message, or '' when there is none. */
function lastAssistantText(history: readonly Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === 'assistant') return m.content;
  }
  return '';
}

/**
 * Dispatch Stop for a finished top-level turn and route the result through
 * the surface's wiring.
 *
 * Contract:
 * - No-op when the surface has not wired Stop (`wiring` undefined), when the
 *   session has no hook registry, or when the session is a forked subagent
 *   (`parentSessionId` set; forks get SubagentStop instead).
 * - Enrichment (`terminalState`, `doneHasCorroboratingEvidence`,
 *   `doneEvidenceClassification`) is computed here from the real tool events,
 *   so every surface, the REPL included, gets identical values.
 * - A block is log-only (`onStopBlocked`); same-turn continuation is handled at
 *   the provider seam (stop-hook-continuation.ts, PR #2740) and must live there,
 *   because the session `done` event is the surface boundary.
 * - `AbortError` propagates from `dispatchStopHook`.
 */
export async function dispatchTurnStop(p: TurnStopParams): Promise<void> {
  const { config, wiring } = p;
  if (wiring === undefined) return;
  const hookRegistry = config.hookRegistry;
  if (!hookRegistry || config.parentSessionId !== undefined) return;

  const terminalKind = parseTerminalState(lastAssistantText(p.conversationHistory))?.kind;
  const isDone = terminalKind === 'done';
  const stopCtx = {
    event: 'Stop' as const,
    sessionId: p.sessionId,
    ...(terminalKind !== undefined ? { terminalState: terminalKind } : {}),
    ...(isDone ? { doneHasCorroboratingEvidence: doneHasCorroboratingEvidence(p.toolEvents) } : {}),
    ...(isDone ? { doneEvidenceClassification: classifyDoneEvidence(p.toolEvents) } : {}),
  };

  const surface = typeof config.surface === 'string' ? config.surface : undefined;
  const result = await dispatchStopHook(hookRegistry, stopCtx, {
    hasNextTurn: wiring.getHasNextTurn(),
    surface,
    signal: p.signal,
    traceWriter: config.traceWriter,
  });

  if (result.wasBlocked) {
    wiring.onStopBlocked?.(result.blockedReason);
  } else if (result.wasTimeout) {
    wiring.onStopTimeout?.();
  } else if (result.injectContext) {
    wiring.onStopInjectContext?.(result.injectContext);
  }
}
