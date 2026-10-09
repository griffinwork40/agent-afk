/**
 * Shared helper for appending a text block to a forked child's system prompt.
 *
 * All three system-prompt injectors — `injectToolBudgetPreamble`,
 * `injectSubagentIdentityPreamble`, and `injectWorkspacePreamble` — handle the
 * same `systemPrompt` union:
 *
 *   - `string` → join with `\n\n`
 *   - preset object (`{ type: 'preset'; preset: ...; append?: string }`) →
 *     append to the `append` field with `\n\n`
 *   - `undefined` → block becomes the prompt
 *
 * This module owns that logic once so each injector stays focused on its own
 * rendering step. Does not mutate the input — returns a shallow copy of the
 * config.
 *
 * @module agent/subagent/append-system-prompt-block
 */

import type { AgentConfig } from '../types/config-types.js';

/**
 * Append `block` to the system prompt of `config`, handling the
 * `string | preset | undefined` union. Returns a new config (shallow copy).
 *
 * When no prompt is set the block becomes the prompt.
 */
export function appendSystemPromptBlock(config: AgentConfig, block: string): AgentConfig {
  const sp = config.systemPrompt;

  if (typeof sp === 'string') {
    return sp.length > 0
      ? { ...config, systemPrompt: `${sp}\n\n${block}` }
      : { ...config, systemPrompt: block };
  }

  if (sp && typeof sp === 'object' && 'type' in sp && sp.type === 'preset') {
    const existingAppend = sp.append ?? '';
    return {
      ...config,
      systemPrompt: {
        ...sp,
        append: existingAppend.length > 0 ? `${existingAppend}\n\n${block}` : block,
      },
    };
  }

  // No system prompt set — the block becomes the system prompt.
  return { ...config, systemPrompt: block };
}
