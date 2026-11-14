/**
 * Live read of `AgentConfig.modelFallbackArmed`.
 *
 * Contract: the provider retry tiers call this at the moment they would
 * otherwise park or fail, never earlier, and never cache the result. The
 * router supplies a function so arming reflects the session's CURRENT model
 * and whether the fallback was already used. A predicate that throws counts as
 * not armed, so a router bug degrades to today's behaviour instead of
 * swallowing the pause.
 *
 * @module agent/providers/shared/model-fallback-armed
 */
import type { AgentConfig } from '../../types/config-types.js';

/** True when the retry tiers should emit `model.fallback_request` right now. */
export function isModelFallbackArmed(config: Pick<AgentConfig, 'modelFallbackArmed'> | undefined): boolean {
  const armed = config?.modelFallbackArmed;
  if (typeof armed !== 'function') return armed === true;
  try {
    return armed() === true;
  } catch {
    return false;
  }
}
