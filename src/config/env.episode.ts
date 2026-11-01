/**
 * Episode synthesis env vars: a contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted as a standalone file following the env.memory-gc.ts and
 * env.whatif.ts precedents. `env.ts` spreads this into `ENV_REGISTRY`.
 *
 * Contract: data only. Never read `process.env` here; `EnvVarMeta` is
 * imported as a type only so there is no runtime cycle.
 *
 * @module config/env.episode
 */

import type { EnvVarMeta } from './env.js';

export const EPISODE_ENV_REGISTRY = [
  {
    name: 'AFK_EPISODE_SYNTHESIS',
    description:
      'Enable automatic episode synthesis at session end. When set to 1, a ' +
      'compressed narrative of each top-level session is synthesized from its ' +
      'sealed journal and stored in cross-session memory (facts table, ' +
      'category: learning). Off by default — opt in once the memory archive ' +
      'is large enough that episodic recall adds value. Requires a valid ' +
      'Anthropic credential; falls back to a deterministic record if the ' +
      'LLM call fails. Use `afk episode synthesize <session-id>` to ' +
      'synthesize a specific session on demand regardless of this flag.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_EPISODE_RECALL',
    description:
      'Enable automatic episode recall at session start. When set to 1, ' +
      'stored episodes whose filesKey or branch overlaps with the current ' +
      'git context are surfaced as a <recent-episodes> block in the system ' +
      'prompt (up to 3 episodes, capped at ~6K tokens). Off by default — ' +
      'opt in once the episode archive is large enough to make associative ' +
      'recall useful (≥50 episodes). Requires AFK_EPISODE_SYNTHESIS to have ' +
      'been running long enough to accumulate episodes.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
