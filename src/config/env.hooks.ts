/**
 * Hook-feature env vars. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted into a dedicated module so each new opt-in hook flag lands here
 * rather than bloating `env.misc.ts` or `env.debug.ts`.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.hooks
 */

import type { EnvVarMeta } from './env.js';

export const HOOKS_ENV_REGISTRY = [
  {
    name: 'AFK_UNPROVEN_DIAGNOSIS_GATE',
    description:
      'Opt-in Stop hook that prevents a turn from closing with an unproven ' +
      '"external / root cause unknown" diagnosis. When set to 1, the hook ' +
      'scans the final assistant text for cause-unknown language ("root cause" ' +
      'near "not found|unknown", "something else in", "likely upstream") AND ' +
      'checks for the absence of instrumentation tool calls (hash/manifest ' +
      'checks, bypass reruns, counter/log insertions). When both conditions ' +
      'are met it injects a correction asking the agent to run the elimination ' +
      'ladder (byte-verify installs, bypass wrapper, clean-env repeat, ' +
      'instrument the path) before closing. Fires at most once per turn. ' +
      'Does not fire when instrumentation evidence is already present, or on ' +
      'subagent turns. Default: 0 (off).',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
