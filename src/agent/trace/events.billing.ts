/**
 * Zod schemas for billing-normalized token counts (#3878), shared by the
 * `subagent_lifecycle.succeeded` payload and the `session_sealed.billing`
 * rollup. `uncachedInput` excludes cache reads on every provider, so
 * `cacheRead / (uncachedInput + cacheRead + cacheWrite)` is a true hit rate.
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
