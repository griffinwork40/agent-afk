/**
 * Agent-layer trusted-skill registry — minimal membership check.
 *
 * The CLI display layer (trusted-skill-badge.ts) owns badge metadata (glyph,
 * color, inFlightVerb). The agent layer only needs to know whether a skill is
 * "trusted" so it can emit lifecycle events. This module holds that Set and
 * exposes a registration hook that the CLI calls at startup.
 *
 * Keeping this in src/agent/ ensures skill-executor.ts remains headless-
 * testable without pulling in chalk or any CLI display dependency.
 */

const trustedSkillNames = new Set<string>();

/**
 * Mark a skill name as trusted. Called by registerTrustedSkill() in
 * trusted-skill-badge.ts so the agent layer stays in sync without importing
 * the badge module.
 */
export function registerTrustedSkillName(name: string): void {
  trustedSkillNames.add(name);
}

/**
 * Returns true when the given skill name has been registered as trusted.
 */
export function isTrustedSkill(name: string): boolean {
  return trustedSkillNames.has(name);
}

/**
 * Clear all registrations. Test-only — not guarded by env check; restrict by
 * convention (call only from afterEach / beforeEach in test files).
 */
export function clearTrustedSkillNamesForTesting(): void {
  trustedSkillNames.clear();
}
