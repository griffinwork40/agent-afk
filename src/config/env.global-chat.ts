/**
 * Global-chat env var registry entry. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted as its own sub-module per the 350-line ceiling rule so the single
 * new entry does not bloat `env.misc.ts` and keeps the registry split auditable.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.global-chat
 */

import type { EnvVarMeta } from './env.js';

export const GLOBAL_CHAT_ENV_REGISTRY = [
  {
    name: 'AFK_GLOBAL_CHAT_URL',
    description:
      'WebSocket URL of the global-chat relay server. When unset, /global falls ' +
      'back to the official AFK relay at ' +
      'wss://afk-global-chat-relay.griffinwork40.workers.dev/v1/room/global. ' +
      'Set this to point /global at a different relay instead.',
    type: 'string',
    required: false,
    default: 'wss://afk-global-chat-relay.griffinwork40.workers.dev/v1/room/global',
    example: 'wss://relay.example.com/v1/room/global',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
