// Contract: billing totals and the settled-through watermark belong to a run,
// not a reusable handle. Stream closures retain this context after a timeout;
// catch arms its terminal outcome before callbacks or asynchronous trace writes.
// Each settlement synchronously advances the watermark before reporting a delta.
// Unsuccessful reports are billing-only; legacy completion counters stay unchanged.
// Lifecycle rows contain cumulative totals, not deltas; the rollup is authoritative.
import type { BillingUsage } from '../provider.js';
import { billingLifecycleFields } from '../usage.billing.js';
import type { SubagentHandleImpl } from './handle.js';

export type SubagentUnsuccessfulOutcome = 'failed' | 'cancelled';

/** Mutable ledger captured by every stream and settlement in one run. */
export interface RunBillingContext {
  total?: BillingUsage;
  reported?: BillingUsage;
  terminalOutcome?: SubagentUnsuccessfulOutcome;
  /**
   * Cumulative USD cost across ALL turns of the run (initial + drain turns),
   * accumulated from each `done` event's `metadata.totalCostUsd`. Replaces
   * the last-turn-only `lastMsg.metadata.totalCostUsd` in the success path
   * so `subagentCostUsd` in `session_sealed` reflects the full run cost.
   * `undefined` when no provider reports pricing (e.g. unknown/local models).
   */
  cumulativeCostUsd?: number;
}

const sub = (a: number, b: number): number => Math.max(0, a - b);

/** Pure per-counter delta; a first all-zero report is still data. */
export function unreportedBillingDelta(context: RunBillingContext): BillingUsage | undefined {
  const total = context.total;
  if (total === undefined) return undefined;
  const prior = context.reported;
  if (prior === undefined) return { ...total };
  const delta: BillingUsage = {
    provider: total.provider,
    uncachedInput: sub(total.uncachedInput, prior.uncachedInput),
    cacheRead: sub(total.cacheRead, prior.cacheRead),
    cacheWrite: sub(total.cacheWrite, prior.cacheWrite),
    output: sub(total.output, prior.output),
  };
  const empty = delta.uncachedInput === 0 && delta.cacheRead === 0 && delta.cacheWrite === 0 && delta.output === 0;
  return empty ? undefined : delta;
}

/** Advance synchronously so reentrant settlement cannot count a delta twice. */
export function takeUnreportedBilling(context: RunBillingContext): BillingUsage | undefined {
  const delta = unreportedBillingDelta(context);
  if (delta !== undefined && context.total !== undefined) context.reported = { ...context.total };
  return delta;
}

/**
 * Report billing (and cost) for an unsuccessful run and return cumulative
 * lifecycle fields when a delta exists.
 *
 * `context.cumulativeCostUsd` is forwarded as the `costUsd` argument so
 * failed and cancelled children contribute their spend to the parent's
 * `subagentRunningCostUsd` accumulator — fixing #3882 cause 1.
 */
export function settleUnreportedBilling<T>(
  handle: SubagentHandleImpl<T>,
  outcome: SubagentUnsuccessfulOutcome,
  context: RunBillingContext = handle._billingContext,
): ReturnType<typeof billingLifecycleFields> {
  const billing = takeUnreportedBilling(context);
  if (billing === undefined) return {};
  handle.onSubagentSucceeded?.({ billing, outcome }, context.cumulativeCostUsd);
  return billingLifecycleFields(context.total);
}

/** Track live streams from creation, including ones abandoned by timeout races. */
export function trackBillingStream<T>(
  pending: Set<Promise<void>>,
  stream: Promise<T>,
  sink?: Set<Promise<void>>,
): Promise<T> {
  const completion = stream.then(() => {}, () => {});
  pending.add(completion);
  sink?.add(completion);
  void completion.then(() => { pending.delete(completion); sink?.delete(completion); });
  return stream;
}
