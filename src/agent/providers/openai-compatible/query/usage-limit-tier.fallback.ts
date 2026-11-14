/**
 * Model-fallback decisions for the openai-compatible quota tier
 * (`usage-limit-tier.ts`). When the session has a `models.fallback` model
 * armed and the user turn has produced nothing yet, the tier asks the router
 * to switch models (`model.fallback_request`) instead of parking on a quota
 * 429 or surfacing a model rejection.
 *
 * Contract: eligibility needs all three of
 *   - `firstRequestOfTurn`: the tier runs once per tool round, so only the
 *     turn driver knows whether earlier rounds (or a Stop-hook continuation
 *     segment) already yielded output; it passes that in explicitly;
 *   - no progress yielded inside this iteration (see {@link isFallbackProgress});
 *   - `isArmed()` true, read live at the moment of decision, never cached.
 *
 * @module agent/providers/openai-compatible/query/usage-limit-tier.fallback
 */

import type { ModelFallbackReason, ProviderEvent } from '../../../provider.js';
import { classifyModelRejection } from '../../shared/model-rejected-error.js';

type ErrorEvent = Extract<ProviderEvent, { type: 'error' }>;
type FallbackRequestEvent = Extract<ProviderEvent, { type: 'model.fallback_request' }>;

/** Fallback wiring the turn driver threads into the quota tier. */
export interface QuotaFallbackContext {
  /** True only for the first model request of the user turn (round 0, no Stop-hook continuation). */
  readonly firstRequestOfTurn: boolean;
  /** Live read of `isModelFallbackArmed(config)`; called at decision time only. */
  readonly isArmed: () => boolean;
  /** The model this request was sent to, for `classifyModelRejection`. */
  readonly model: string;
}

/**
 * True when a yielded event means the turn has made user-visible progress, so
 * replaying it on another model would duplicate output.
 *
 * Not progress: `stream.retry` (a throttle signal telling surfaces to discard
 * a partial paint that, before any delta, is empty) and a `fast-tier` notice
 * (an operator advisory that the service tier was downgraded; it carries no
 * model output and nothing of the turn is lost or repeated by a replay on the
 * fallback model). Everything else (deltas, assistant messages, tool events,
 * `paused`) is progress.
 */
export function isFallbackProgress(event: ProviderEvent): boolean {
  if (event.type === 'stream.retry') return false;
  if (event.type === 'notice' && event.kind === 'fast-tier') return false;
  return true;
}

function isEligible(progressed: boolean, fb: QuotaFallbackContext | undefined): fb is QuotaFallbackContext {
  return fb !== undefined && fb.firstRequestOfTurn && !progressed;
}

function request(reason: ModelFallbackReason, error: Error, sessionId: string): FallbackRequestEvent {
  return { type: 'model.fallback_request', reason, error, sessionId };
}

/** The `usage-limit` request to yield instead of `paused`, or null for today's park. */
export function quotaFallbackRequest(
  quotaEvent: ErrorEvent,
  progressed: boolean,
  fb: QuotaFallbackContext | undefined,
  sessionId: string,
): FallbackRequestEvent | null {
  if (!isEligible(progressed, fb) || !fb.isArmed()) return null;
  return request('usage-limit', quotaEvent.error, sessionId);
}

/** The `model-rejected` request to yield instead of `event`, or null to yield it as today. */
export function modelRejectedFallbackRequest(
  event: ProviderEvent,
  progressed: boolean,
  fb: QuotaFallbackContext | undefined,
  sessionId: string,
): FallbackRequestEvent | null {
  if (event.type !== 'error' || !isEligible(progressed, fb)) return null;
  if (classifyModelRejection(event.error, fb.model, 'openai-compatible') === undefined) return null;
  if (!fb.isArmed()) return null;
  return request('model-rejected', event.error, sessionId);
}
