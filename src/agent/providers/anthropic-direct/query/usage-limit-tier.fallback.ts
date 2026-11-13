/**
 * Model-fallback decision for the usage-limit retry tier (`models.fallback`).
 *
 * Contract: when `AgentConfig.modelFallbackArmed` reads true AT THE MOMENT OF
 * DECISION and nothing but throttle signals has been yielded outward for the
 * current user turn, the tier yields ONE `model.fallback_request` and ends the
 * turn instead of parking (`paused`), failing on an empty credit balance, or
 * surfacing a model rejection. `ProviderRouter` consumes the request and
 * replays the turn on the fallback model. Otherwise behaviour is unchanged.
 *
 * Invariant: "progress" is tracked per `RunTurnInput`, not per tier generator.
 * The overload-pause tier re-invokes the usage-limit tier with a FRESH
 * generator for every probe, but always with the same `runInput` object (one
 * per user turn, like `runInput.turnState`). An earlier probe may already have
 * forwarded partial deltas and the overload notice, so a generator-local flag
 * would wrongly re-arm the fallback on a later probe and duplicate output. The
 * WeakMap lets the entry die with the turn's input.
 *
 * @module agent/providers/anthropic-direct/query/usage-limit-tier.fallback
 */

import type { ModelFallbackReason, ProviderEvent } from '../../../provider.js';
import { isModelFallbackArmed } from '../../shared/model-fallback-armed.js';
import { classifyModelRejection } from '../../shared/model-rejected-error.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext } from './retry-context.js';

const turnsWithProgress = new WeakMap<RunTurnInput, true>();

/** Throttle signals that may precede the first model output without counting as progress. */
function isThrottleSignal(event: ProviderEvent): boolean {
  return event.type === 'rate_limit' || event.type === 'stream.retry';
}

/** Record that `event` is about to be yielded outward for this turn. */
export function noteOutwardEvent(runInput: RunTurnInput, event: ProviderEvent): void {
  if (!isThrottleSignal(event)) turnsWithProgress.set(runInput, true);
}

/** Record progress unconditionally (e.g. before delegating to a park that yields `paused`). */
export function noteTurnProgress(runInput: RunTurnInput): void {
  turnsWithProgress.set(runInput, true);
}

/** True when something other than a throttle signal was yielded for this turn. */
export function turnHasProgress(runInput: RunTurnInput): boolean {
  return turnsWithProgress.has(runInput);
}

/**
 * Build the request when the fallback is eligible right now, else `null`.
 * Reads the armed predicate LIVE on every call; never cache the result.
 */
export function modelFallbackRequest(
  ctx: Pick<RetryTierContext, 'modelFallbackArmed'>,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  reason: ModelFallbackReason,
  error: Error,
): ProviderEvent | null {
  if (isClosed() || runInput.signal.aborted) return null;
  if (turnHasProgress(runInput)) return null;
  if (!isModelFallbackArmed({ modelFallbackArmed: ctx.modelFallbackArmed })) return null;
  return { type: 'model.fallback_request', reason, error, sessionId: runInput.ctx.sessionId };
}

/** Request for an `error` event that rejects the model in use, else `null`. */
export function modelRejectedFallbackRequest(
  ctx: Pick<RetryTierContext, 'modelFallbackArmed'>,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  error: Error,
): ProviderEvent | null {
  if (!classifyModelRejection(error, runInput.model, 'anthropic')) return null;
  return modelFallbackRequest(ctx, runInput, isClosed, 'model-rejected', error);
}
