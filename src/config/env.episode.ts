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
      'deterministic summary of each top-level session is built from its ' +
      'facet and stored in cross-session memory (facts table, ' +
      'category: episode). Off by default — opt in once the memory archive ' +
      'is large enough that episodic recall adds value. No LLM call is ' +
      'required; episodes are derived from existing facet data. Use ' +
      '`afk episode synthesize <session-id>` to synthesize a specific ' +
      'session on demand regardless of this flag.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
