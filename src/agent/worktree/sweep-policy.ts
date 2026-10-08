/**
 * Shared sweep-policy resolver for worktree prune age limits.
 *
 * Both the CLI (`afk worktree prune`) and the REPL (`/worktree prune`) need to
 * resolve `maxAgeDaysClean` / `maxAgeDaysDirty` using the same precedence:
 *
 *   flag (CLI-only) > config (daemon.worktreePrune) > env var > engine default
 *
 * This module is the single source of truth for that resolution so the two call
 * sites cannot diverge. It lives in `src/agent/` and is intentionally free of
 * `src/cli/` imports — callers pass the already-read values in as plain numbers.
 *
 * @module agent/worktree/sweep-policy
 */

/** Default age limits used when no override, config value, or env var is set. */
export const SWEEP_POLICY_DEFAULTS = {
  maxAgeDaysClean: 14,
  maxAgeDaysDirty: 30,
} as const;

export interface SweepPolicyInputs {
  /**
   * Explicit flag values from the CLI (`--max-age-days-clean` /
   * `--max-age-days-dirty`).  `undefined` means the flag was not supplied.
   */
  overrides?: {
    maxAgeDaysClean?: number;
    maxAgeDaysDirty?: number;
  };

  /**
   * Values from the `daemon.worktreePrune` config block (already parsed to
   * numbers by the config loader).  `undefined` means the key was absent.
   */
  config?: {
    maxAgeDaysClean?: number;
    maxAgeDaysDirty?: number;
  };

  /**
   * Values from the typed `env` object (`env.AFK_WORKTREE_MAX_AGE_CLEAN` /
   * `env.AFK_WORKTREE_MAX_AGE_DIRTY`).  Pass `undefined` when the var is unset.
   * Callers are responsible for reading through `src/config/env.ts` — this
   * function must not access `process.env` directly.
   */
  env?: {
    maxAgeDaysClean?: string | undefined;
    maxAgeDaysDirty?: string | undefined;
  };
}

export interface SweepPolicyResult {
  maxAgeDaysClean: number;
  maxAgeDaysDirty: number;
}

/**
 * Resolve sweep age-limit policy using flag > config > env > default precedence.
 *
 * @param inputs - Already-read values from each source layer.
 * @returns Resolved `maxAgeDaysClean` and `maxAgeDaysDirty` as positive integers.
 */
export function resolveSweepPolicy(inputs: SweepPolicyInputs): SweepPolicyResult {
  const { overrides, config, env } = inputs;

  const envClean = parseInt(env?.maxAgeDaysClean ?? '', 10);
  const envDirty = parseInt(env?.maxAgeDaysDirty ?? '', 10);

  const maxAgeDaysClean =
    overrides?.maxAgeDaysClean ??
    config?.maxAgeDaysClean ??
    (Number.isNaN(envClean) ? SWEEP_POLICY_DEFAULTS.maxAgeDaysClean : envClean);

  const maxAgeDaysDirty =
    overrides?.maxAgeDaysDirty ??
    config?.maxAgeDaysDirty ??
    (Number.isNaN(envDirty) ? SWEEP_POLICY_DEFAULTS.maxAgeDaysDirty : envDirty);

  return { maxAgeDaysClean, maxAgeDaysDirty };
}
