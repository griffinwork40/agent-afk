/**
 * Exactly-once (by amount) billing settlement for a subagent run (#3878).
 *
 * Contract: every token of a child's summed billing (`handle._runBilling`)
 * reaches the parent's `session_sealed.billing.subagents` rollup EXACTLY ONCE
 * per run, whatever the run's terminal outcome and however many settlement
 * points fire. Settlement is tracked BY AMOUNT, not by a boolean: the handle
 * records the cumulative total already handed to the parent
 * (`_billingReportedTotal`) and every settlement point reports only the
 * unreported DELTA (`_runBilling − _billingReportedTotal`, per counter), via
 * {@link takeUnreportedBilling}. Settlement points:
 *
 *   - succeeded → `drainAndEmitSuccess` hands legacy fields + the billing
 *     delta to `onSubagentSucceeded` (legacy counters unchanged).
 *   - failed / cascade-cancelled / explicit `cancel()` / the post-cancel
 *     branch of `run()`'s catch → {@link settleUnreportedBilling} hands a
 *     BILLING-ONLY delta, tagged `outcome: 'failed' | 'cancelled'`, to the
 *     same callback.
 *
 * So spend that arrives AFTER an explicit `cancel()` already settled (a
 * `done` drained on interrupt, or a drain turn finishing during the cancel)
 * is still reported — as its own delta — by the next settlement point, and a
 * `cancel()` after a fully reported success reports nothing.
 *
 * The `outcome` tag is what keeps legacy semantics intact: the accumulator
 * (`AccountingAccumulator.recordSubagentCompletion`) adds a tagged report to
 * the billing rollup ONLY — `subagentCompletedCount`, `subagentRunningTokens`,
 * `subagentRunningCostUsd`, and the tree-budget check stay success-only.
 * Routing through the existing callback means every surface that already
 * wires `setOnSubagentSucceeded` → `recordSubagentCompletion` picks this up
 * with no edit, because each forwards `usage` verbatim.
 *
 * Lifecycle rows are NOT deltas: a terminal row carries the CUMULATIVE
 * `{ provider, tokens }` known when it is emitted. The `succeeded` row always
 * does (`emitSuccessfulHandoff`); a failed/cancelled row does only when its
 * settlement had an unreported delta (so a cancel after a reported success
 * carries none). An explicit `cancelled` row may therefore UNDERCOUNT spend
 * that lands after it, and a cancel during a drain can put overlapping
 * cumulative totals on both the `cancelled` and the `succeeded` row. The
 * rollup is authoritative for totals — never sum lifecycle rows.
 *
 * `_billingReportedTotal` is reset with `_runBilling` at the start of every
 * `run()`, so a re-run reports its own spend.
 *
 * @module agent/subagent/handle.billing
 */

import type { BillingUsage } from '../provider.js';
import { billingLifecycleFields } from '../usage.billing.js';
import type { SubagentHandleImpl } from './handle.js';

/** Non-success terminal outcomes that settle billing without a completion. */
export type SubagentUnsuccessfulOutcome = 'failed' | 'cancelled';

const sub = (a: number, b: number): number => Math.max(0, a - b);

/**
 * The run's billing not yet handed to the parent, per counter. Returns the
 * full total when nothing was reported yet (even an all-zero total: reported
 * zero is data), `undefined` when the run accrued no billing or the delta
 * since the last report is all-zero. Pure — does not record anything.
 */
export function unreportedBillingDelta<T>(handle: SubagentHandleImpl<T>): BillingUsage | undefined {
  const total = handle._runBilling;
  if (total === undefined) return undefined;
  const prior = handle._billingReportedTotal;
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

/**
 * Return the unreported delta AND record the current total as reported, in
 * one synchronous step, so no interleaving settlement can report it again.
 */
export function takeUnreportedBilling<T>(handle: SubagentHandleImpl<T>): BillingUsage | undefined {
  const delta = unreportedBillingDelta(handle);
  if (delta !== undefined && handle._runBilling !== undefined) {
    handle._billingReportedTotal = { ...handle._runBilling };
  }
  return delta;
}

/**
 * Settle a failed/cancelled run's billing: roll the unreported delta into the
 * parent (billing-only, tagged with `outcome`) and return the CUMULATIVE
 * `{ provider, tokens }` lifecycle fields for the terminal trace row. Returns
 * `{}` — and reports nothing — when there is no unreported delta (no billing,
 * or all of it already reported, e.g. cancel after success).
 */
export function settleUnreportedBilling<T>(
  handle: SubagentHandleImpl<T>,
  outcome: SubagentUnsuccessfulOutcome,
): ReturnType<typeof billingLifecycleFields> {
  const billing = takeUnreportedBilling(handle);
  if (billing === undefined) return {};
  // Non-literal on purpose: the callback's declared param type is the legacy
  // `SubagentTrace['usage']`; the extra `outcome` tag rides along structurally
  // and is read by `AccountingAccumulator.recordSubagentCompletion`.
  const usage = { billing, outcome };
  handle.onSubagentSucceeded?.(usage, undefined);
  return billingLifecycleFields(handle._runBilling);
}
