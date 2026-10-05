/**
 * Progress-event emitter for tool-dispatch rounds.
 *
 * Extracted from `runTurnInner` (turn-driver.ts) to keep it under the
 * 200-line function ceiling. All parameters are explicit — no closure
 * over outer locals.
 *
 * @module agent/providers/openai-compatible/query/turn-driver.progress
 */

import type { ProviderEvent, ProviderUsage } from '../../../provider.js';
import { finalizedToolCalls, type StreamState } from '../translate.js';
import { formatRoundLabel } from '../../shared/tool-loop-cap.js';
import { summarizeToolInput } from '../../shared/tool-input-summary.js';

/**
 * Build a `progress` ProviderEvent summarising the just-completed tool round.
 *
 * Returns the count of tool calls in this round so the caller can accumulate.
 */
export function buildRoundProgressEvent(
  sessionId: string,
  state: StreamState,
  taskId: string,
  round: number,
  maxIterations: number,
  accumulatedUsage: ProviderUsage,
  toolCallCount: number,
  turnStartTime: number,
): ProviderEvent {
  const roundCalls = finalizedToolCalls(state);
  const lastCall = roundCalls.at(-1);
  const lastToolName = lastCall?.name;
  let lastCallInput: unknown;
  try {
    lastCallInput = lastCall ? JSON.parse(lastCall.argumentsRaw || '{}') : undefined;
  } catch {
    lastCallInput = undefined;
  }
  const lastToolHeadline = lastCall
    ? `${lastCall.name}${summarizeToolInput(lastCall.name, lastCallInput)}`
    : 'unknown';
  return {
    type: 'progress',
    progress: {
      taskId,
      description: 'Working',
      summary: `${formatRoundLabel(round, maxIterations)}: ${lastToolHeadline}`,
      lastToolName,
      totalTokens: accumulatedUsage.totalTokens ?? 0,
      toolUses: toolCallCount,
      durationMs: Date.now() - turnStartTime,
    },
    sessionId,
  };
}
