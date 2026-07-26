/**
 * `/usage` — report the operator's Claude subscription usage (5-hour rolling
 * and 7-day windows) into this chat.
 *
 * Delegates entirely to fetchSubscriptionUsage() (src/agent/subscription-usage.ts),
 * which never throws — failures come back as a `kind: 'unavailable'` result and
 * are rendered via formatUsage(). The try/catch below is a last-resort guard
 * only, matching the defensive posture of the other command handlers in this
 * directory (e.g. handlers/afk.ts).
 */

import type { Context } from 'telegraf';
import { fetchSubscriptionUsage } from '../../agent/subscription-usage.js';
import { formatError, formatUsage } from '../formatter.js';

type LogFn = (...args: unknown[]) => void;

export async function handleUsage(ctx: Context, log: LogFn): Promise<void> {
  try {
    const result = await fetchSubscriptionUsage();
    await ctx.reply(formatUsage(result));
  } catch (error) {
    log('Usage command error:', error);
    await ctx.reply(formatError('Could not fetch usage'));
  }
}
