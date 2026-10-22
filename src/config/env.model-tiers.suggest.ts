/**
 * REPL suggestion env vars. Extracted from `env.model-tiers.ts` to keep that
 * file within the 350-code-line ceiling. `env.ts` spreads this tuple into
 * `ENV_REGISTRY` alongside the main model-tiers block.
 *
 * @module config/env.model-tiers.suggest
 */

import type { EnvVarMeta } from './env.js';

export const SUGGEST_ENV_REGISTRY = [
  {
    name: 'AFK_SUGGEST_ENABLED',
    description: 'Enable the LLM-backed ghost-text suggestion tier in the interactive REPL. On by default. Set to 0/false/no/off to disable.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_PROMPT',
    description: 'Enable LLM-generated empty-prompt suggestions — a proposed next action shown as ghost text when the prompt is blank, accepted with Tab or Right-arrow. Fires only after a turn has completed in the session: the startup prompt (and the prompt right after /clear) is left clean because there is no session context to ground a proposal in. On by default. Set to 0/false/no/off to disable. Requires AFK_SUGGEST_ENABLED (it reuses the same suggestion model and provider).',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_GHOST',
    description: 'Enable REPL ghost-text inline suggestions (Tier-1 history/dropdown + optional Tier-2 LLM). 1 = on (default), 0 = off. Set 0/false/off/no to disable all ghost text. Tier-2 LLM is separately gated by AFK_SUGGEST_ENABLED.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_MODEL',
    description: 'Override the small model used for REPL ghost-text suggestions. Falls back to AFK_COMPACT_MODEL or haiku-class for anthropic, or the session model for other providers.',
    type: 'string',
    required: false,
    category: 'model',
  },
] as const satisfies readonly EnvVarMeta[];
