/**
 * Per-provider billing rollup (#3878). Accumulates billing-normalized token
 * counts (see `agent/usage.billing.ts`) for the root session and, separately,
 * for subagents — succeeded, failed, AND cancelled children alike (see
 * `subagent/handle.billing.ts`) — so `session_sealed` can report true cache
 * hit rates split by provider instead of one blended figure.
 *
 * @module agent/session/billing-rollup
 */

import type { BillingUsage } from '../provider.js';
import type { BillingCounters, BillingRollupSnapshot } from '../trace/events.billing.js';

// Single source of truth: the zod schemas in `trace/events.billing.ts`.
export type { BillingCounters, BillingRollupSnapshot } from '../trace/events.billing.js';

const zero = (): BillingCounters => ({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

const addInto = (target: BillingCounters, b: BillingCounters): void => {
  target.uncachedInput += b.uncachedInput;
  target.cacheRead += b.cacheRead;
  target.cacheWrite += b.cacheWrite;
  target.output += b.output;
};

export class BillingRollup {
  private total: BillingCounters = zero();
  private byProvider = new Map<string, BillingCounters>();
  /**
   * True once any defined billing record was added. Gates `snapshot()` so a
   * provider that REPORTED usage with all-zero counts still surfaces a rollup
   * (reported-zero is data; never-reported is absence).
   */
  private recorded = false;

  /** Add one billing record. A missing record (provider reported none) is a no-op. */
  add(b: BillingUsage | undefined): void {
    if (!b) return;
    this.recorded = true;
    addInto(this.total, b);
    let bucket = this.byProvider.get(b.provider);
    if (!bucket) {
      bucket = zero();
      this.byProvider.set(b.provider, bucket);
    }
    addInto(bucket, b);
  }

  reset(): void {
    this.total = zero();
    this.byProvider = new Map();
    this.recorded = false;
  }

  /** Undefined when no billing record was ever added, so the seal payload omits the field. */
  snapshot(): BillingRollupSnapshot | undefined {
    if (!this.recorded) return undefined;
    const byProvider: Record<string, BillingCounters> = {};
    for (const [provider, counters] of this.byProvider) byProvider[provider] = { ...counters };
    return { total: { ...this.total }, byProvider };
  }
}

/** Spread helper: `{ [key]: snap }` when present, `{}` otherwise (exactOptionalPropertyTypes-safe). */
export function optionalBilling<K extends string>(
  key: K,
  snap: BillingRollupSnapshot | undefined,
): Partial<Record<K, BillingRollupSnapshot>> {
  return snap !== undefined ? ({ [key]: snap } as Record<K, BillingRollupSnapshot>) : {};
}

/**
 * `session_sealed` spread: `{ billing: { root?, subagents? } }` when either
 * rollup recorded anything, `{}` otherwise (legacy seals stay byte-identical).
 */
export function sealBillingField(
  root: BillingRollupSnapshot | undefined,
  subagents: BillingRollupSnapshot | undefined,
): { billing?: { root?: BillingRollupSnapshot; subagents?: BillingRollupSnapshot } } {
  if (root === undefined && subagents === undefined) return {};
  return {
    billing: {
      ...(root !== undefined ? { root } : {}),
      ...(subagents !== undefined ? { subagents } : {}),
    },
  };
}
