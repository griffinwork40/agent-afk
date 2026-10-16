/**
 * Per-provider billing rollup (#3878). Accumulates billing-normalized token
 * counts (see `agent/usage.billing.ts`) for the root session and, separately,
 * for completed subagents, so `session_sealed` can report true cache hit
 * rates split by provider instead of one blended figure.
 *
 * @module agent/session/billing-rollup
 */

import type { BillingUsage } from '../provider.js';

/** Billing counters without the provider tag. */
export interface BillingCounters {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Snapshot shape, emitted verbatim on `session_sealed.billing.{root,subagents}`. */
export interface BillingRollupSnapshot {
  total: BillingCounters;
  byProvider: Record<string, BillingCounters>;
}

const zero = (): BillingCounters => ({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

const addInto = (target: BillingCounters, b: BillingCounters): void => {
  target.uncachedInput += b.uncachedInput;
  target.cacheRead += b.cacheRead;
  target.cacheWrite += b.cacheWrite;
  target.output += b.output;
};

const isEmpty = (c: BillingCounters): boolean =>
  c.uncachedInput === 0 && c.cacheRead === 0 && c.cacheWrite === 0 && c.output === 0;

export class BillingRollup {
  private total: BillingCounters = zero();
  private byProvider = new Map<string, BillingCounters>();

  /** Add one billing record. A missing record (provider reported none) is a no-op. */
  add(b: BillingUsage | undefined): void {
    if (!b) return;
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
  }

  /** Undefined when nothing was recorded, so the seal payload omits the field. */
  snapshot(): BillingRollupSnapshot | undefined {
    if (isEmpty(this.total)) return undefined;
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
