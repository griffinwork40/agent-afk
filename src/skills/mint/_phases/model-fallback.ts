/**
 * Default-tier model fallback for /mint phase forks.
 *
 * Contract: the mint handler resolves its phase model ONCE
 * (`resolveChildModel({defaultSubagentModel, defaultModel})`) and records the
 * derived fallback here keyed by the parent session id; every mint fork site
 * (`_fork-phase.ts`, build, heal, verify, parallelize-dispatch) reads it back
 * with {@link mintModelFallback} and passes it to `forkSubagent`. Keyed by
 * session so concurrent mints in different sessions cannot see each other's
 * value; each mint invocation (fresh or resumed) overwrites it before any phase forks. The retry itself
 * lives in subagent/handle.model-fallback.ts.
 *
 * @module skills/mint/_phases/model-fallback
 */

import type { ForkSubagentOptions } from '../../../agent/subagent/fork-types.js';

const fallbackBySession = new Map<string, NonNullable<ForkSubagentOptions['modelFallback']>>();

export function setMintModelFallback(parentSessionId: string, fallback: ForkSubagentOptions['modelFallback']): void {
  if (fallback === undefined) fallbackBySession.delete(parentSessionId);
  else fallbackBySession.set(parentSessionId, fallback);
}

/** Spread into a mint `forkSubagent` options object. */
export function mintModelFallback(parentSessionId: string | undefined): Pick<ForkSubagentOptions, 'modelFallback'> {
  const fallback = parentSessionId === undefined ? undefined : fallbackBySession.get(parentSessionId);
  return fallback !== undefined ? { modelFallback: fallback } : {};
}
