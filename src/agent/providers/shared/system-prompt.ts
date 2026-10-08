/**
 * Shared system-prompt overlay normalizer — provider-neutral.
 *
 * Both providers accept a `systemPrompt` field that may be:
 *   - `string` — a plain operator overlay, used as-is.
 *   - `{ type: 'preset'; preset: 'claude_code'; append?: string }` — a preset
 *     object. The preset itself has no analog on provider direct paths, so we
 *     forward only the `append` portion (the user's explicit additions).
 *   - `undefined` — no operator overlay; provider falls back to defaults.
 *
 * Previously each provider implemented this normalization separately.
 * `openai-compatible/system-prompt-wiring.ts` used
 * `typeof config.systemPrompt === 'string' ? config.systemPrompt : undefined`,
 * which silently dropped the `append` text of a preset object (issue #3261).
 *
 * This module provides the canonical normalizer so both providers produce the
 * same logical prompt sections for the same config.
 *
 * @module agent/providers/shared/system-prompt
 */

import type { AgentConfig } from '../../types/config-types.js';

/**
 * Normalize a `systemPrompt` config field to a plain string overlay or null.
 *
 * - `string` → returned as-is when non-empty, else `null`.
 * - `{ type: 'preset', …, append? }` → the `append` text when non-empty, else
 *   `null`. The preset identifier itself is not forwarded on direct API paths.
 * - `undefined` / anything else → `null`.
 */
export function normalizeSystemPromptOverlay(
  sp: AgentConfig['systemPrompt'],
): string | null {
  if (sp === undefined) return null;
  if (typeof sp === 'string') return sp.length > 0 ? sp : null;
  if (typeof sp === 'object' && sp !== null && (sp as { type?: string }).type === 'preset' && 'append' in sp) {
    const append = (sp as { append?: string }).append;
    return typeof append === 'string' && append.length > 0 ? append : null;
  }
  return null;
}
