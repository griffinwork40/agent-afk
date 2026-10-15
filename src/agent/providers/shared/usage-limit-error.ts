/**
 * Wrap a terminal usage-limit `error` event in the provider-neutral
 * {@link UsageLimitError}, so every surface (REPL error card, Telegram, a
 * failed subagent's result) shows the same provider-labeled sentence instead
 * of the raw SDK text or 429 JSON.
 *
 * Shared by both providers' usage-limit tiers. Called ONLY at the points
 * where a usage limit ends the turn (fail-fast, a reset beyond the wait
 * budget, the wait budget spent), never on an error a tier still classifies
 * or retries: the tiers key on the RAW error, so wrapping earlier would hide
 * it from them.
 *
 * @module agent/providers/shared/usage-limit-error
 */

import type { ProviderEvent } from '../../provider.js';
import { UsageLimitError, type UsageLimitInfo } from '../../../utils/errors.js';
import { describeUsageLimit } from '../../usage/usage-formatter.js';

/** Build a {@link UsageLimitError} around `cause`, with the friendly message. */
export function toUsageLimitError(cause: unknown, info: UsageLimitInfo, now: number = Date.now()): UsageLimitError {
  if (cause instanceof UsageLimitError) return cause;
  return new UsageLimitError(describeUsageLimit(info, now), info, { cause });
}

/**
 * Return `event` with its error wrapped as a {@link UsageLimitError}.
 * Non-error events pass through unchanged.
 */
export function usageLimitErrorEvent(event: ProviderEvent, info: UsageLimitInfo): ProviderEvent {
  if (event.type !== 'error') return event;
  return { type: 'error', error: toUsageLimitError(event.error, info) };
}
