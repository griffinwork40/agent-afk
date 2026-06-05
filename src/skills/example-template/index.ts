/**
 * Example template skill demonstrating the multi-prompt loader pattern.
 *
 * This skill:
 * 1. Loads its prompts via loadSkillPrompts('example-template')
 * 2. Merges them into a single systemPrompt (concatenated by alphabetical order)
 * 3. Delegates execution to SubagentManager.forkSubagent()
 * 4. Registers itself via registerSkill() on import
 */

import { loadSkillPrompts } from '../_lib/prompt-loader.js';
import { registerSkill } from '../index.js';

/**
 * Handler for the example-template skill.
 * Loads prompts and merges them.
 */
async function handler(input: unknown): Promise<unknown> {
  // Load all prompts from prompts/ directory
  const prompts = loadSkillPrompts('example-template');

  // Merge prompts in alphabetical order by filename
  const promptKeys = Object.keys(prompts).sort();
  const mergedPrompt = promptKeys
    .map((key) => prompts[key])
    .join('\n\n---\n\n');

  // For testing purposes, we'll return a simple result
  // In a real skill, this would fork a subagent with the merged prompt via:
  // const manager = new SubagentManager();
  // const result = await manager.forkSubagent({ ... });
  return {
    skill: 'example-template',
    input,
    promptCount: promptKeys.length,
    promptKeys,
    mergedPromptPreview: mergedPrompt.substring(0, 100),
  };
}

// Register the skill on import.
//
// audience: 'internal' — this is a developer-facing scaffolding template,
// not a user-runnable amplifier. Hidden from public surfaces unless
// `AFK_INTERNAL=1` is set. Note: this module is not imported by
// `src/skills/all.ts`, so today the registration is dormant — the audience
// tag is defensive so the tier remains correct if/when it becomes wired in.
registerSkill({
  name: 'example-template',
  description: 'Example template skill demonstrating multi-prompt loader',
  handler,
  audience: 'internal',
});
