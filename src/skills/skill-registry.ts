/**
 * Skill registry — singleton Map, registration functions, and visibility helpers.
 *
 * Types ({@link SkillMetadata}, {@link SkillExecutionContext}, {@link SkillCategory},
 * {@link SKILL_CATEGORIES}, {@link UNCATEGORIZED_LABEL}) live in
 * {@link ./skill-types.js} so they can be imported without pulling in the
 * singleton registry Map.
 */

export type {
  SkillExecutionContext,
  SkillMetadata,
  SkillCategory,
} from './skill-types.js';
export { SKILL_CATEGORIES, UNCATEGORIZED_LABEL } from './skill-types.js';

import type { SkillMetadata } from './skill-types.js';

/**
 * Test whether a registered skill should be visible at end-user surfaces
 * given the current runtime tier.
 *
 * Returns true when the skill is public-audience (or absent — public is the
 * default) OR when `internalUnlocked` is true. Returns false only when the
 * skill is explicitly tagged 'internal' AND the runtime tier is locked.
 *
 * Callers wire `internalUnlocked` from `env.AFK_INTERNAL === '1'` at the
 * call site so the env-var read is always live (matches the lazy-getter
 * contract in env.ts). Centralising the check here keeps the gate semantics
 * single-sourced — if the policy ever changes (e.g. config-file flag instead
 * of env var) only this function moves.
 */
export function isSkillVisible(
  skill: Pick<SkillMetadata, 'audience'>,
  internalUnlocked: boolean,
): boolean {
  if (internalUnlocked) return true;
  return (skill.audience ?? 'public') === 'public';
}

const registry = new Map<string, SkillMetadata>();

/**
 * Register a skill in the global registry.
 */
export function registerSkill(meta: SkillMetadata): void {
  registry.set(meta.name, meta);
}

/**
 * Get a registered skill by name.
 * @throws Error if skill not found, with list of available skills
 */
export function getSkill(name: string): SkillMetadata {
  const skill = registry.get(name);
  if (skill) {
    return skill;
  }

  const available = Array.from(registry.keys()).sort();
  const availableMsg = available.length > 0 ? `\nAvailable skills: ${available.join(', ')}` : '';
  throw new Error(`Skill not found: ${name}${availableMsg}`);
}

/**
 * List all registered skill names.
 */
export function listSkills(): string[] {
  return Array.from(registry.keys()).sort();
}

/**
 * List registered skill names visible at end-user surfaces given the current
 * runtime tier.
 *
 * Centralises the audience gate so all surfacing call sites (slash-command
 * listing, detail lookup, loading tips, tab-complete) share one filtered
 * accessor rather than each inlining the isSkillVisible() predicate.
 *
 * Pass `internalUnlocked = env.AFK_INTERNAL === '1'` at the call site so the
 * env-var read is always live (matches the lazy-getter contract in env.ts).
 */
export function listVisibleSkills(internalUnlocked: boolean): string[] {
  return listSkills().filter((name) => isSkillVisible(getSkill(name), internalUnlocked));
}

/**
 * Evict all skills whose `origin` matches the given value.
 *
 * Used by `collectSkillEntries()` before each project scan so that skills
 * registered for a previous cwd do not persist when the working directory
 * changes in a long-lived process (daemon, Telegram bot). Only
 * `'project'`-origin entries are evicted in production; the caller is
 * responsible for passing the correct origin.
 *
 * User-origin (`~/.afk/skills/`) and built-in (undefined origin) skills are
 * never passed here and therefore survive across cwd changes, which is the
 * correct steady-state: global skills are cwd-agnostic.
 *
 * Returns the number of registry entries removed.
 */
export function evictSkillsByOrigin(origin: SkillMetadata['origin']): number {
  let removed = 0;
  for (const [key, meta] of registry) {
    if (meta.origin === origin) {
      registry.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Internal: reset registry for testing.
 * Marked with underscore to indicate test-only usage.
 */
export function _resetRegistry(): void {
  registry.clear();
}
