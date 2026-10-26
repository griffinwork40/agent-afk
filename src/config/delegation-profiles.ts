/**
 * Named delegation profiles for `AFK_DELEGATION_PROFILE`.
 *
 * A profile bundles the four delegation-budget env vars
 * (AFK_MAX_NESTING_DEPTH, AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT,
 * AFK_MAX_CONCURRENT_AGENTS, AFK_MAX_TOTAL_AGENTS) into a single knob.
 * Individual env vars always override profile values — the profile is the
 * default; explicit vars are the override.
 *
 * Built-in profiles
 * -----------------
 *   `normal`  (default) — depth 3, no budget limits (matches historic defaults)
 *   `deep`              — depth 5, wider fan-out budgets
 *   `shallow`           — depth 2, tighter fan-out budgets
 *
 * Unknown or missing profile names return `undefined`; callers fall through
 * to their own defaults in that case (same philosophy as env-var range-guard
 * fallbacks elsewhere in the config layer).
 *
 * @module config/delegation-profiles
 */

// ─── Profile shape ───────────────────────────────────────────────────────────

/** All values a profile may contribute. `undefined` means "no limit". */
export interface DelegationProfileValues {
  maxNestingDepth: number;
  maxConcurrentChildrenPerAgent: number | undefined;
  maxConcurrentAgents: number | undefined;
  maxTotalAgents: number | undefined;
}

// ─── Built-in presets ────────────────────────────────────────────────────────

export const DELEGATION_PROFILES = Object.freeze({
  /**
   * `normal` — historic AFK defaults. No budget caps; depth 3.
   * This is the implicit behaviour when AFK_DELEGATION_PROFILE is unset.
   */
  normal: {
    maxNestingDepth: 3,
    maxConcurrentChildrenPerAgent: undefined,
    maxConcurrentAgents: undefined,
    maxTotalAgents: undefined,
  },

  /**
   * `deep` — for orchestration-heavy sessions that need deeper nesting and
   * more concurrent children (e.g. /god, /mint with many parallel probes).
   * depth 5, maxChildren 4, maxConcurrent 16, maxTotal 48.
   */
  deep: {
    maxNestingDepth: 5,
    maxConcurrentChildrenPerAgent: 4,
    maxConcurrentAgents: 16,
    maxTotalAgents: 48,
  },

  /**
   * `shallow` — for cost-sensitive or latency-sensitive sessions.
   * depth 2, maxChildren 2, maxConcurrent 8, maxTotal 16.
   */
  shallow: {
    maxNestingDepth: 2,
    maxConcurrentChildrenPerAgent: 2,
    maxConcurrentAgents: 8,
    maxTotalAgents: 16,
  },
} as const);

export type DelegationProfileName = keyof typeof DELEGATION_PROFILES;

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the active delegation profile from `AFK_DELEGATION_PROFILE`.
 *
 * Returns the profile values when a known profile name is set, or `undefined`
 * when the var is unset or names an unknown profile (callers fall back to
 * their own defaults in that case).
 *
 * @param raw  The raw string value of `env.AFK_DELEGATION_PROFILE`.
 */
export function resolveDelegationProfile(
  raw: string | undefined,
): DelegationProfileValues | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim().toLowerCase();
  if (name === '') return undefined;
  if (!Object.hasOwn(DELEGATION_PROFILES, name)) return undefined;
  const profile = DELEGATION_PROFILES[name as DelegationProfileName];
  if (profile === undefined) return undefined;
  return profile;
}
