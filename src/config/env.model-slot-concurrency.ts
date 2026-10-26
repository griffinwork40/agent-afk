/**
 * Per-slot concurrency cap env vars (`AFK_MODEL_<TIER>_MAX_CONCURRENCY`).
 *
 * Extracted from `env.model-tiers.ts` to keep that file within the 350-code-line
 * ceiling. `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate
 * position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.model-slot-concurrency
 */

import type { EnvVarMeta } from './env.js';

export const MODEL_SLOT_CONCURRENCY_ENV_REGISTRY = [
  {
    name: 'AFK_MODEL_LOCAL_MAX_CONCURRENCY',
    description:
      'Per-slot concurrency cap for the "local" tier. When set, at most N model requests to ' +
      "this slot's endpoint are in flight simultaneously (shared with any other slot targeting " +
      'the same baseUrl). Useful for single-request local servers (Ollama, LM Studio, MLX). ' +
      'Unset = unlimited. Accepted range 1-32; out-of-range or unparseable input is ignored. ' +
      'Part of #3886.',
    type: 'number',
    required: false,
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_LARGE_MAX_CONCURRENCY',
    description:
      'Per-slot concurrency cap for the "large" tier. When set, at most N model requests to ' +
      "this slot's endpoint are in flight simultaneously. Unset = unlimited. Accepted range 1-32. " +
      'Part of #3886.',
    type: 'number',
    required: false,
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_MEDIUM_MAX_CONCURRENCY',
    description:
      'Per-slot concurrency cap for the "medium" tier. When set, at most N model requests to ' +
      "this slot's endpoint are in flight simultaneously. Unset = unlimited. Accepted range 1-32. " +
      'Part of #3886.',
    type: 'number',
    required: false,
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_SMALL_MAX_CONCURRENCY',
    description:
      'Per-slot concurrency cap for the "small" tier. When set, at most N model requests to ' +
      "this slot's endpoint are in flight simultaneously. Unset = unlimited. Accepted range 1-32. " +
      'Part of #3886.',
    type: 'number',
    required: false,
    example: '1',
    category: 'model',
  },
] as const satisfies readonly EnvVarMeta[];
