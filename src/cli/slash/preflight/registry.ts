/**
 * Preflight registry. Maps bare skill name → preflight function.
 *
 * Lookups are by *bare* name (no slash, no `<plugin>:` prefix) so a single
 * registered preflight covers vendored, user, project, and plugin sources
 * of the same skill name. If/when divergent preflights per source become
 * necessary, the lookup can grow a (name, source) key without breaking
 * existing callers.
 *
 * **Immutability contract (F03 security hardening):**
 * Keys registered during `initBuiltinPreflights()` are treated as first-party
 * and are immutable — subsequent `registerPreflight` calls for the same name
 * are rejected with a warning. This prevents a plugin from silently overwriting
 * a trusted built-in preflight (e.g. `review-pr`) with attacker-controlled code.
 *
 * The `force` option is an escape hatch for tests — it bypasses immutability.
 * It MUST NOT be used in production paths.
 */

import type { PreflightContext, PreflightResult, SkillInvocation, SkillPreflight } from './types.js';

const preflights = new Map<string, SkillPreflight>();

/**
 * Names registered during first-party init. Once a name appears here,
 * subsequent registrations for it are rejected (unless `force` is true).
 */
const firstPartyKeys = new Set<string>();

/**
 * Mark the current set of registered keys as first-party (trusted).
 * Called by `initBuiltinPreflights()` after all built-in preflights have been
 * registered. Safe to call multiple times (idempotent).
 */
export function _sealBuiltinKeys(): void {
  for (const k of preflights.keys()) {
    firstPartyKeys.add(k);
  }
}

/**
 * Register a preflight for a bare skill name.
 *
 * If `skillName` is already registered as a first-party key, the registration
 * is rejected and a warning is emitted to stderr. Pass `{ force: true }` to
 * bypass this check (tests only — never use in production code).
 */
export function registerPreflight(
  skillName: string,
  preflight: SkillPreflight,
  opts: { force?: boolean } = {},
): void {
  if (!opts.force && firstPartyKeys.has(skillName)) {
    // F03: silently reject overwrites of trusted keys instead of crashing,
    // so a badly-behaved plugin cannot break the REPL.
    process.stderr.write(
      `[afk preflight] ⚠ Rejected attempt to overwrite first-party preflight "${skillName}". ` +
      `Use { force: true } in tests if this is intentional.\n`,
    );
    return;
  }
  preflights.set(skillName, preflight);
}

/** Look up a preflight for a bare skill name. Returns undefined when none registered. */
export function getPreflight(skillName: string): SkillPreflight | undefined {
  return preflights.get(skillName);
}

/**
 * Clear all registered preflights and the sealed-key set.
 *
 * @internal Test-only escape hatch. Never call in production code.
 *   Use `initBuiltinPreflights()` to re-register built-ins after clearing.
 */
export function _clearPreflightsForTests(): void {
  preflights.clear();
  firstPartyKeys.clear();
}

/**
 * Run the registered preflight for an invocation, with failure isolation.
 *
 * Returns `null` when no preflight is registered, when the registered
 * preflight returns `null` (signals "not applicable"), or when the
 * preflight throws. Errors are surfaced via the optional `onError` hook
 * so callers can log without coupling to a specific logger.
 *
 * Preflight failures must never block a skill from running — the worst
 * case is that the model falls back to its previous discovery behavior.
 */
export async function runPreflight(
  inv: SkillInvocation,
  ctx: PreflightContext,
  onError?: (err: unknown) => void,
): Promise<PreflightResult | null> {
  const preflight = preflights.get(inv.skillName);
  if (!preflight) return null;

  try {
    return await preflight(inv, ctx);
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
}
