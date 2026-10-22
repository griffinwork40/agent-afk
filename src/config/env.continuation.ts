/**
 * Subagent continuation chain limits (docs/subagent-continuation.md, D4): a
 * contiguous slice of `ENV_REGISTRY`.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`), and it imports `EnvVarMeta` as a
 * type only so there is no runtime cycle.
 *
 * @module config/env.continuation
 */

import type { EnvVarMeta } from './env.js';

export const CONTINUATION_ENV_REGISTRY = [
  {
    name: 'AFK_SUBAGENT_CONTINUATION_MAX_ROUNDS',
    description:
      'Aggregate tool-round limit per subagent continuation chain (the initial dispatch plus ' +
      'every `continuation_chain_id` continuation). The initial attempt is charged at its round ' +
      'cap (or its runtime-counted rounds when uncapped); each continuation is charged its full ' +
      'finite allowance at admission, clipped to what remains. No refunds. Unset, empty, ' +
      'non-numeric, or < 1 falls back to the default 150.',
    type: 'number',
    required: false,
    default: '150',
    example: '300',
    category: 'model',
  },
  {
    name: 'AFK_SUBAGENT_CONTINUATION_MAX_CONTINUATIONS',
    description:
      'Maximum number of continuations per subagent continuation chain (not counting the ' +
      'initial dispatch). 0 disables continuation entirely (every continuation call is ' +
      'refused). Unset, empty, non-numeric, or negative falls back to the default 3.',
    type: 'number',
    required: false,
    default: '3',
    example: '5',
    category: 'model',
  },
] as const satisfies readonly EnvVarMeta[];
