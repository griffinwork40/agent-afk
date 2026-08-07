import type { ToolFailureClass } from './trace/types.js';
import { BudgetExceededError, TimeoutError } from '../utils/errors.js';

/** Provider-level reason preserved on the per-turn AbortSignal. */
export type ProviderAbortReason = 'interrupted' | 'timeout' | 'budget' | 'closed';

/**
 * Reduce the session controller's open-ended reason to the provider contract.
 * Typed errors are authoritative; string fallbacks preserve compatibility with
 * the budget producer and callers that serialize errors before aborting.
 */
export function providerAbortReason(reason: unknown): ProviderAbortReason {
  if (reason instanceof TimeoutError) return 'timeout';
  if (reason instanceof BudgetExceededError) return 'budget';
  if (typeof reason === 'string') {
    if (reason === 'budget' || reason.startsWith('Budget ')) return 'budget';
    if (reason === 'timeout' || reason.includes('timed out')) return 'timeout';
    if (reason === 'closed') return 'closed';
  }
  return 'interrupted';
}

/** Classify a synthetic tool failure from the reason preserved on its signal. */
export function abortFailureClass(signal: AbortSignal): ToolFailureClass {
  const reason = providerAbortReason(signal.reason);
  if (reason === 'timeout' || reason === 'budget') return reason;
  return 'abort';
}
