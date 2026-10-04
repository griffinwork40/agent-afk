/**
 * Anthropic-side adapters onto the provider-neutral usage-limit error.
 *
 * Sibling of `usage-limit.ts` (kept separate so that file stays under its
 * size ceiling). Maps the Anthropic classification onto
 * {@link import('../../../utils/errors.js').UsageLimitInfo} and wraps a
 * terminal usage-limit `error` event so its message is the shared
 * `describeUsageLimit` sentence.
 *
 * @module agent/providers/anthropic-direct/usage-limit.error
 */

import type { ProviderEvent } from '../../provider.js';
import type { UsageLimitInfo } from '../../../utils/errors.js';
import { usageLimitErrorEvent } from '../shared/usage-limit-error.js';

/** Provider-neutral info for a Claude subscription limit. */
export function anthropicSubscriptionLimit(resetsAt?: Date): UsageLimitInfo {
  return { provider: 'anthropic', kind: 'subscription', ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/** Wrap a terminal Claude subscription-limit error event. */
export function anthropicLimitErrorEvent(event: ProviderEvent, resetsAt?: Date): ProviderEvent {
  return usageLimitErrorEvent(event, anthropicSubscriptionLimit(resetsAt));
}

/** Wrap a terminal empty-credit-balance error event (status 400 preserved). */
export function anthropicCreditErrorEvent(event: ProviderEvent): ProviderEvent {
  return usageLimitErrorEvent(event, { provider: 'anthropic', kind: 'credit' });
}
