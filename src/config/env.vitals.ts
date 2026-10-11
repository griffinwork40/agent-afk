/**
 * Vitals harness note env vars: a contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted into a dedicated module so the per-round vitals flag lands here
 * rather than bloating `env.misc.ts` or `env.hooks.ts`.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.vitals
 */

import type { EnvVarMeta } from './env.js';

export const VITALS_ENV_REGISTRY = [
  {
    name: 'AFK_VITALS',
    description:
      'Per-round "[vitals]" harness note appended to each tool-result turn so ' +
      'the model stays aware of fast-changing state: local wall-clock time and ' +
      'elapsed turn time every round, time left before the soft deadline when ' +
      'one is set, context-window fill once it reaches 50%, and (root ' +
      'Anthropic sessions only) Claude subscription usage once it reaches 80%. ' +
      'Set to 0 to disable. Default: on.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
