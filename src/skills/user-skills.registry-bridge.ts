/**
 * Thin bridge that notifies the PromptRegistry after user/project SKILL.md
 * files are scanned from disk. Extracted into its own file so the
 * notification logic does not push user-skills.ts past the 350-LOC ceiling.
 *
 * Call {@link notifyUserSkillsLoaded} once per `scanSkillsFromDir` invocation.
 * The dynamic import keeps user-skills.ts free of a direct registry import,
 * preventing any circular-dependency issues that could arise if the registry
 * ever transitively imports skills code.
 *
 * @module skills/user-skills.registry-bridge
 */

/**
 * Notify the PromptRegistry that user/project SKILL.md files have been
 * scanned, so its cache is invalidated and the next `getPromptRegistry()`
 * call re-discovers all files including the newly loaded user skills.
 *
 * Fire-and-forget: errors are silently swallowed so a misconfigured registry
 * never breaks skill scanning.
 */
export function notifyUserSkillsLoaded(): void {
  import('../prompts/registry.js')
    .then(({ notifyPromptLoaded }) => { notifyPromptLoaded(); })
    .catch(() => undefined);
}
