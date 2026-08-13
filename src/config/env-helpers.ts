/**
 * Runtime helper functions over the env registry.
 *
 * Extracted from `env.ts` to keep that file within the 350-line ceiling.
 * All functions re-exported from `env.ts` so existing import sites are
 * unchanged.
 *
 * @module config/env-helpers
 */

import { ENV_REGISTRY } from './env.js';
import type { EnvVarMeta, EnvVarCategory } from './env.js';

/**
 * Look up a registry entry by name. Returns undefined if the var is unknown.
 * Used by `/doctor` for the required-var check.
 */
export function getEnvVarMeta(name: string): EnvVarMeta | undefined {
  return ENV_REGISTRY.find((e) => e.name === name);
}

/**
 * Return the list of vars where `required: true` and the current process has
 * no value set. Consumed by `/doctor` and surface-specific bootstrap code.
 *
 * `requiredFor` lets callers scope the check — e.g., the Telegram surface
 * passes `'telegram'` and gets only TELEGRAM_BOT_TOKEN + AFK_TELEGRAM_ALLOWED_CHAT_IDS.
 */
export function getMissingRequiredEnvVars(category?: EnvVarCategory): EnvVarMeta[] {
  return ENV_REGISTRY.filter((e) => {
    if (!e.required) return false;
    if (category !== undefined && e.category !== category) return false;
    return process.env[e.name] === undefined || process.env[e.name] === '';
  });
}

/**
 * Whether an env var is currently set in this process's environment.
 *
 * The `env` object exposes a static getter per known var; this covers the
 * DYNAMIC case — checking presence of a name only known at runtime (e.g. while
 * iterating `ENV_REGISTRY`). Keeping the dynamic `process.env` read here, rather
 * than at the call site, preserves the "all env access lives in env.ts"
 * invariant enforced by `pnpm audit:env:check`.
 */
export function isEnvVarSet(name: string): boolean {
  return process.env[name] !== undefined;
}

/**
 * Read an env var's value by a name known only at runtime.
 *
 * Contract: returns `undefined` for both unset AND empty-string, because every
 * config-overriding read site in the loader is truthiness-gated (`if
 * (env.AFK_MODEL)`, env-tier.ts:206) — an empty var does NOT override config, so
 * reporting it as a live override would be a lie. This deliberately differs from
 * {@link isEnvVarSet}, which answers presence (`!== undefined`) and would call an
 * empty var "set".
 *
 * Same rationale as `isEnvVarSet` for living here: the dynamic `process.env` read
 * stays inside env.ts, preserving the invariant enforced by `pnpm audit:env:check`.
 */
export function getEnvVarValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}
