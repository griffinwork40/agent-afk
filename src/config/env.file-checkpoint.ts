/**
 * File-checkpoint retention env vars: a contiguous slice of `ENV_REGISTRY`
 * spliced in through `env.session-storage.ts` (so `env.ts` needs no new
 * import), following the `env.session-tmpdir.ts` precedent.
 *
 * Contract: data only. Never read `process.env` here (the single read-point
 * stays `env.ts`); `EnvVarMeta` is imported as a type so there is no cycle.
 *
 * @module config/env.file-checkpoint
 */

import type { EnvVarMeta } from './env.js';

export const FILE_CHECKPOINT_ENV_REGISTRY = [
  {
    name: 'AFK_FILE_CHECKPOINT_BASH_DISABLE',
    description: 'Disable best-effort git-backed capture of foreground bash file changes for /rewind.',
    type: 'boolean', required: false, example: '1', category: 'debug',
  },
  {
    name: 'AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS',
    description: 'Maximum milliseconds per bash checkpoint capture or diff. Default 5000.',
    type: 'number', required: false, default: '5000', category: 'debug',
  },
  {
    name: 'AFK_FILE_CHECKPOINT_BASH_MAX_FILES',
    description: 'Maximum changed files captured per bash call; larger diffs are reported as partial. Default 1000.',
    type: 'number', required: false, default: '1000', category: 'debug',
  },
  {
    name: 'AFK_FILE_CHECKPOINT_RETENTION_DISABLE',
    description:
      'Disable the file-checkpoint retention sweep (state/file-checkpoints/), so no ' +
      'session checkpoint directory is ever evicted.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_FILE_CHECKPOINT_MAX_AGE_DAYS',
    description:
      'Evict a file-checkpoint session directory once its newest content is older than ' +
      'this many days. Default 14.',
    type: 'number',
    required: false,
    default: '14',
    category: 'debug',
  },
  {
    name: 'AFK_FILE_CHECKPOINT_MAX_BYTES',
    description:
      'Aggregate byte cap for state/file-checkpoints/; oldest session directories are ' +
      'evicted first once exceeded. Default 1073741824 (1 GiB).',
    type: 'number',
    required: false,
    default: '1073741824',
    category: 'debug',
  },
] as const satisfies readonly EnvVarMeta[];
