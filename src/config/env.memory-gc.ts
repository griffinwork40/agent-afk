/**
 * Memory GC sweep env vars: a contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling,
 * following the `env.session-storage.ts` and `env.whatif.ts` precedents.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the position the entries
 * used to occupy, so registry order, the derived `EnvObject` / `EnvVarName`
 * types, and the rendered `docs/env-registry.*` are unchanged.
 *
 * Contract: data only. Never read `process.env` here (the single read-point
 * stays `env.ts`); `EnvVarMeta` is imported as a type so there is no cycle.
 *
 * @module config/env.memory-gc
 */

import type { EnvVarMeta } from './env.js';

export const MEMORY_GC_ENV_REGISTRY = [
  {
    name: 'AFK_MEMORY_GC_SWEEP_ENABLE',
    description:
      'Enable the periodic soft-delete GC sweep for the fact archive. ' +
      'When set to 1, never-accessed facts older than AFK_MEMORY_GC_MIN_AGE_DAYS ' +
      'are marked superseded (soft-deleted) at most once every 24 hours at session ' +
      'start. Off by default — enable only when archive noise becomes measurable. ' +
      '"preference" facts and facts predating this database\'s tracking-start marker ' +
      'are always excluded regardless of this setting.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_MEMORY_GC_MIN_AGE_DAYS',
    description:
      'Minimum age in days for a never-accessed fact to become a GC candidate. ' +
      'Only meaningful when AFK_MEMORY_GC_SWEEP_ENABLE=1. Default 30. Age is counted only for facts created since tracking began. ' +
      'Must be a positive number; invalid values fall back to the default.',
    type: 'number',
    required: false,
    default: '30',
    example: '60',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
