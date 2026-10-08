/**
 * Per-session temp-dir env vars: a contiguous slice of `ENV_REGISTRY`.
 *
 * Kept out of `env.ts` (grandfathered over the 350-code-line ceiling),
 * following the `env.session-storage.ts` precedent. `env.ts` spreads this
 * tuple into `ENV_REGISTRY`.
 *
 * Contract: data only. Never read `process.env` here (the single read-point
 * stays `env.ts`); `EnvVarMeta` is imported as a type so there is no cycle.
 *
 * @module config/env.session-tmpdir
 */

import type { EnvVarMeta } from './env.js';

export const SESSION_TMPDIR_ENV_REGISTRY = [
  {
    name: 'AFK_SESSION_TMPDIR_DISABLE',
    description:
      'Disable per-session private temp dirs. By default every session and subagent gets its ' +
      'own directory under <os tmpdir>/afk-<uid>/ (removed on close) injected as TMPDIR/TMP/TEMP ' +
      'into bash and test_run child processes, so one session cleaning its temp files cannot ' +
      "delete a concurrent session's. Set to 1 to share the inherited TMPDIR instead.",
    type: 'boolean',
    required: false,
    example: '1',
    category: 'process',
  },
] as const satisfies readonly EnvVarMeta[];
