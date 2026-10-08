import { env } from '../../../config/env.js';
import { emitSessionPhase } from '../../trace/emit.js';
import type { TraceSink } from '../../trace/index.js';

export const CONTEXT_PRESSURE_WIND_DOWN = 'context_pressure_wind_down';
export const CONTEXT_PRESSURE_NOTE =
  'Context capacity is nearly exhausted. Do not request tools. Return partial findings, saved work, and remaining steps now.';
// Contract: INV-034 uses ONE request footprint, never summed usage. Three bytes
// per token is a conservative projection, not a tokenizer guarantee.
//
// Terminology used in this module and callers:
//   - documented model capacity: the underlying model's context window as
//     documented by the model vendor. Unknown here; may differ from provider limits.
//   - effective provider-route limit: client-catalog metadata for a specific
//     provider route (e.g. 272,000 for the Codex subscription route). Consistent
//     with observed failures. NOT a guaranteed server cutoff.
//   - operational threshold: policy applied by this guard. A fraction of the
//     effective provider-route limit, configurable via AFK_CONTEXT_GUARD_PCT.
export function projectedContextTokens(lastRoundTokens: number, appendedBytes: number): number {
  return Math.ceil(lastRoundTokens + appendedBytes / 3);
}

/**
 * Return the operational threshold fraction for the named provider route, or
 * null when the guard is disabled (off switch or unconfigured API-key path).
 *
 * History: added 2026-10-06 (B2) as a temporary, route-specific configurable
 * guard. 'Temporary' means it will be removed once a provider-side mechanism
 * (streaming usage, real-time token counts) can substitute. The default 0.95
 * was chosen by replaying the three observed fatal journals: 95% of 258,400
 * (the catalog effective limit = context_window * effective_context_window_pct)
 * prevents both dead children's fatal requests while cutting the survivor only
 * 1 batch early (82nd of 82 batches). Higher fractions fired too late for
 * dead-6 (real ctx 278k already past the 272k route limit).
 *
 * Anthropic-path parity: the same `projectedContextTokens` helper could be
 * used, but wiring it into the Anthropic loop requires non-trivial changes that
 * go beyond a 'small change':
 *   1. `TurnAccumulator.usage.contextWindowTokens` is set AFTER each round
 *      completes (`addRoundUsage`), so a pre-send check must use the previous
 *      round's value — the same stale-by-one-round pattern the OpenAI path uses
 *      for `lastUsage`, but there is no equivalent accessible field in
 *      `RunTurnInput` today.
 *   2. `contextLimitFor(model, false)` (Anthropic never uses the subscription
 *      path) would need to be called with the resolved wire model string from
 *      inside the loop, where `input.model` is available.
 *   3. The injection site is between `runToolRound` and the next `openRound`
 *      inside `loop.ts`, which already exceeds 400 lines; adding a guard block
 *      there would grow it further and require a new sub-module.
 * Net assessment: feasible with a dedicated B3 lane; not a small change to add
 * here without risking regression in the Anthropic-direct loop.
 */
export function contextGuardFraction(
  route: 'codex-subscription' | 'anthropic' | 'openai-api',
): number | null {
  if (/^(1|true|yes|on)$/i.test(env.AFK_CONTEXT_GUARD_DISABLE ?? '')) return null;
  const configured = env.AFK_CONTEXT_GUARD_PCT;
  const percent = Number(configured ?? '95');
  // All routes use 95% by default. The guard is route-specific only in WHICH
  // limit value it applies to: codex-subscription uses the catalog effective
  // limit (context_window × effective_context_window_pct); openai-api and
  // anthropic routes use contextLimitFor() with subscriptionPath=false.
  void route; // route parameter reserved for future per-route defaults
  return (Number.isFinite(percent) && percent >= 1 && percent <= 99 ? percent : 95) / 100;
}

export function contextPressure(
  lastRoundTokens: number,
  appendedBytes: number,
  limit: number,
  fraction = 0.95,
): boolean {
  return limit > 0 && projectedContextTokens(lastRoundTokens, appendedBytes) >= limit * fraction;
}

/**
 * Emit a context_pressure_wind_down trace event. Uses the actual fraction to
 * record the operational threshold (policy), not a hardcoded value.
 */
export function traceContextPressure(
  trace: TraceSink | undefined,
  projected: number,
  limit: number,
  fraction = 0.95,
): void {
  void emitSessionPhase(trace, {
    phase: CONTEXT_PRESSURE_WIND_DOWN,
    metadata: {
      projectedTokens: projected,
      effectiveProviderRouteLimitTokens: limit,
      operationalThresholdTokens: Math.round(limit * fraction),
      operationalThresholdFraction: fraction,
      documentedModelCapacity: 'unknown',
      routeLimitSource: 'client metadata; not a guaranteed server cutoff',
    },
  });
}
