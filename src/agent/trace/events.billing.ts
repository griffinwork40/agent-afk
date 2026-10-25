/**
 * Zod schemas for billing-normalized token counts (#3878), shared by the
 * `subagent_lifecycle` terminal payloads (`succeeded` / `failed` /
 * `cancelled`) and the `session_sealed.billing` rollup. `uncachedInput`
 * excludes cache reads on every provider, so
 * `cacheRead / (uncachedInput + cacheRead + cacheWrite)` is a true hit rate.
 *
 * Contract: these schemas are the single source of truth for the billing
 * counter shapes. The TS types below are `z.infer`-derived and re-exported
 * under their historical names by `trace/types.ts` (`SessionBillingCounters`,
 * `SessionBillingRollup`) and `session/billing-rollup.ts` (`BillingCounters`,
 * `BillingRollupSnapshot`), so a schema edit can never drift from the types.
 * This module imports only zod, so importing it from either side is cycle-free.
 *
 * @module agent/trace/events.billing
 */

import { z } from 'zod';

export const BillingCountersSchema = z.object({
  uncachedInput: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

export const BillingRollupSchema = z.object({
  total: BillingCountersSchema,
  byProvider: z.record(z.string(), BillingCountersSchema),
});

export const SessionBillingSchema = z.object({
  root: BillingRollupSchema.optional(),
  subagents: BillingRollupSchema.optional(),
});

/**
 * Optional `{ provider, tokens }` fields carried by every terminal
 * `subagent_lifecycle` payload when the child accrued billing (#3878).
 * Spread into the succeeded / failed / cancelled payload schemas.
 */
export const BillingLifecycleShape = {
  provider: z.string().optional(),
  tokens: BillingCountersSchema.optional(),
};

/** Billing counters without the provider tag. */
export type BillingCounters = z.infer<typeof BillingCountersSchema>;

/** `{ total, byProvider }` rollup, emitted on `session_sealed.billing.{root,subagents}`. */
export type BillingRollupSnapshot = z.infer<typeof BillingRollupSchema>;

/**
 * Billing fields on the terminal `subagent_lifecycle` payloads (#3878).
 * Present on `succeeded`, `failed`, and `cancelled` whenever the child
 * accrued billing usage before it ended, so spend from a child that failed or
 * was cancelled mid-run is still attributed in the trace.
 */
export interface SubagentBillingFields {
  /**
   * Bundled provider family that served this child (`anthropic-direct` |
   * `openai-compatible` | `mixed`), from its billing usage. `'mixed'` is
   * emitted when the child's turns spanned more than one provider family.
   * Absent when the provider reported no usage.
   */
  provider?: string;
  /**
   * Billing-normalized token counts summed across every turn of the child's
   * run. `uncachedInput` excludes cache reads on every provider, so
   * `cacheRead / (uncachedInput + cacheRead + cacheWrite)` is the child's
   * true prompt-cache hit rate.
   */
  tokens?: BillingCounters;
}
