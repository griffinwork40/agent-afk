/**
 * `AgentSession` glue for the SDK opt-in executor bundle (#3442) and the
 * tree-wide budget gate. Extracted so `agent-session.ts` stays under the
 * 350-code-line ceiling.
 *
 * @module agent/session/agent-session.executors
 */

import type { AgentConfig } from '../types.js';
import type { SessionExecutorsBindTarget } from './session-executors.js';
import type { AccountingAccumulator } from './accounting-accumulator.js';
import { BudgetExceededError } from '../../utils/errors.js';
import { emitBudget } from '../trace/emit.js';

/**
 * Validate `config.executors` and bind it to the constructing session.
 *
 * Contract: throws when `executors` is combined with `provider` or
 * `providerFactory` (an injected provider carries its own executors, so the
 * bundle would be silently ignored). Otherwise calls `executors.bind(session)`
 * exactly once; a bundle already bound to another session throws from its own
 * `bind`. Must run BEFORE the provider lifecycle is built.
 */
export function bindSessionExecutors(config: AgentConfig, session: SessionExecutorsBindTarget): void {
  const executors = config.executors;
  if (executors === undefined) return;
  if (config.provider !== undefined) {
    throw new Error(
      'AgentSession: `executors` cannot be combined with `provider`; an injected provider ' +
        'carries its own executors. Pass executors to the provider instead, or drop `provider`.',
    );
  }
  if (config.providerFactory !== undefined) {
    throw new Error(
      'AgentSession: `executors` cannot be combined with `providerFactory`; the factory must ' +
        'wire executors into the providers it builds. Drop one of the two options.',
    );
  }
  executors.bind(session);
}

type SubagentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

/**
 * Record a completed subagent into the session rollup and enforce the
 * tree-wide `maxBudgetUsd` ceiling.
 *
 * Contract (tree budget, completion granularity): when `config.maxBudgetUsd`
 * is set, the parent's cumulative turn cost PLUS the cumulative cost of every
 * subagent completion recorded so far counts against ONE ceiling. A child's
 * spend is only visible here once the child completes, so a long-running child
 * can overshoot the ceiling before the gate fires. Crossing it emits the same
 * `budget` trace event and aborts with the same {@link BudgetExceededError}
 * the per-turn gate in `stream-consumer.ts` uses, so the closure is classified
 * `budget_exceeded`. No-op on an already-aborted session.
 */
export function recordSubagentCompletionInTree(
  accounting: AccountingAccumulator,
  config: AgentConfig,
  abortController: AbortController,
  usage: SubagentUsage | undefined,
  costUsd: number | undefined,
): void {
  accounting.recordSubagentCompletion(usage, costUsd);
  const max = config.maxBudgetUsd;
  if (max === undefined || abortController.signal.aborted) return;
  const acct = accounting.snapshot();
  const running = acct.sessionRunningCostUsd + acct.subagentRunningCostUsd;
  if (running < max) return;
  // Invariant: emit the threshold-breach record BEFORE aborting (same
  // ordering as the per-turn gate) so it lands before any abort cascade.
  void emitBudget(config.traceWriter, {
    kind: 'monetary',
    runningCostUsd: running,
    maxBudgetUsd: max,
    lastTurnCostUsd: typeof costUsd === 'number' && Number.isFinite(costUsd) ? costUsd : 0,
  });
  abortController.abort(new BudgetExceededError(running, max));
}
