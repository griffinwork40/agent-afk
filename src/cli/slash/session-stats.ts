/**
 * Session-stats factory and per-turn update helper.
 *
 * Stats are held as a single mutable record on the REPL's stack and passed
 * into every SlashContext. The REPL calls `recordTurn()` after each
 * `event.type === 'done'` to fold the turn's metadata into the totals.
 */

import type { ResponseMetadata } from '../../agent/types/message-types.js';
import type { AgentModelInput } from '../../agent/types.js';
import { slugifySessionName } from '../session-name.js';
import type { SessionStats, ToolEvent, TurnRecord } from './types.js';

export function createSessionStats(model: AgentModelInput): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model,
    permissionMode: 'default',
  };
}

/**
 * Reset session counters in-place. Used by `/clear` after the SDK session
 * is rebuilt — the conversation is gone, so per-turn counters/history must
 * be zeroed too. Preserves user-controlled state (`model`, `permissionMode`)
 * and refreshes `sessionStartTime` so elapsed-time displays restart from
 * the clear, not from the original launch. Drops `sessionId` because the
 * rebuilt SDK session will issue a new one, and drops the auto-derived
 * `name` so the next conversation re-derives its own from its first message
 * instead of inheriting (and re-saving a sidecar under) the cleared one.
 */
export function resetStats(stats: SessionStats): void {
  stats.totalTurns = 0;
  stats.totalCostUsd = 0;
  stats.totalTokens = 0;
  stats.totalDurationMs = 0;
  stats.sessionStartTime = Date.now();
  stats.turnCosts.length = 0;
  stats.turnTokens.length = 0;
  stats.turns.length = 0;
  delete stats.sessionId;
  // Drop the auto-derived name too. recordTurn only auto-names when
  // `!stats.name`, so leaving the cleared conversation's name in place would
  // make the NEXT conversation's first turn persist a fresh sidecar under the
  // PREVIOUS conversation's name — a user-visible misattribution.
  delete stats.name;
  // Preserve `permissionMode` (user-controlled state — the plan/AFK gates read
  // it live; `/clear` should not silently drop the operator out of AFK mode).
}

/**
 * Fold a completed turn into session stats and push a TurnRecord for
 * /history. Returns the new per-turn totals for immediate display.
 */
export function recordTurn(
  stats: SessionStats,
  userInput: string,
  assistantText: string,
  metadata: ResponseMetadata | undefined,
  toolEvents?: ToolEvent[],
): TurnRecord {
  const costUsd = metadata?.totalCostUsd ?? 0;
  const durationMs = metadata?.durationMs ?? 0;
  const aggInput = Number(metadata?.usage?.['input_tokens'] ?? 0);
  const aggOutput = Number(metadata?.usage?.['output_tokens'] ?? 0);

  // Top-level usage counters are cumulative across all API iterations in a
  // single agent-loop turn, so summing them overstates per-call context
  // footprint by ~num_iterations. When the SDK provides `usage.iterations`,
  // use the last iteration's values — per BetaUsage docs: "Calculate the
  // true context window size from the last iteration."
  let turnInput = aggInput;
  let turnOutput = aggOutput;
  let turnCache =
    Number(metadata?.usage?.['cache_read_input_tokens'] ?? 0) +
    Number(metadata?.usage?.['cache_creation_input_tokens'] ?? 0);
  const iterations = metadata?.usage?.['iterations'];
  if (Array.isArray(iterations) && iterations.length > 0) {
    const last = iterations[iterations.length - 1];
    if (last && typeof last === 'object') {
      const o = last as Record<string, unknown>;
      turnInput = Number(o['input_tokens'] ?? 0);
      turnOutput = Number(o['output_tokens'] ?? 0);
      turnCache =
        Number(o['cache_read_input_tokens'] ?? 0) +
        Number(o['cache_creation_input_tokens'] ?? 0);
    }
  }

  stats.totalTurns += 1;
  stats.totalCostUsd += costUsd;
  stats.totalDurationMs += durationMs;
  stats.totalTokens += aggInput + aggOutput;
  stats.turnCosts.push(costUsd);
  // Context-window footprint: the provider-computed last-round occupancy
  // (input + cache_read + cache_creation + output for Anthropic; prompt +
  // completion for OpenAI). Preferred by contextRatio over input+output+cache,
  // which mixes cumulative input with last-round cache and overcounts on
  // tool-heavy turns. Falls back to the last-iteration sum when the SDK
  // surfaced per-round `iterations` but no explicit footprint.
  const cwt = Number(metadata?.usage?.['context_window_tokens'] ?? NaN);
  const hadIterations = Array.isArray(iterations) && iterations.length > 0;
  const footprint = Number.isFinite(cwt)
    ? cwt
    : hadIterations
      ? turnInput + turnOutput + turnCache
      : undefined;
  stats.turnTokens.push({
    input: turnInput,
    output: turnOutput,
    cache: turnCache,
    ...(footprint !== undefined ? { footprint } : {}),
  });

  if (metadata?.sessionId && !stats.sessionId) {
    stats.sessionId = String(metadata.sessionId);
  }

  // Auto-name the session from the first user message when no name has been
  // set yet (via /name, /save <name>, or a prior turn). Metadata only — the
  // sidecar is still keyed by sessionId, so this never forks a second file.
  if (!stats.name) {
    const derived = slugifySessionName(userInput);
    if (derived) stats.name = derived;
  }

  const record: TurnRecord = {
    user: userInput,
    assistant: assistantText,
    timestamp: Date.now(),
    costUsd,
    durationMs,
    inputTokens: aggInput,
    outputTokens: aggOutput,
    ...(toolEvents && toolEvents.length > 0 ? { toolEvents } : {}),
  };
  stats.turns.push(record);
  return record;
}
