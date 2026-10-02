/**
 * Peer-messaging env vars — entries added to `ENV_REGISTRY` for the
 * cross-session peer-messaging feature.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.peer
 */

import type { EnvVarMeta } from './env.js';

export const PEER_ENV_REGISTRY = [
  {
    name: 'TMUX',
    description:
      'OS-level tmux session identifier. Set automatically by tmux to the socket path and session info (e.g. /tmp/tmux-501/default,12345,0) inside any tmux pane. ' +
      'Not set by AFK. Read by configureColor() to detect a tmux environment, and by peer messaging to derive a default session name (#S:#I); for truecolor support on Node ≤ 24, set FORCE_COLOR=3 in your shell or ~/.afk/config/afk.env.',
    type: 'string',
    required: false,
    example: '/tmp/tmux-501/default,12345,0',
    category: 'process',
  },  {
    name: 'AFK_PEER_INBOUND',
    description:
      "How this REPL session handles incoming peer messages. " +
      "'accept' (default) delivers messages to the model at the next idle turn. " +
      "'hold' writes them to held/ for /inbox review. " +
      "'off' ignores incoming messages. Invalid values silently fall back to 'accept'.",
    type: 'string',
    required: false,
    default: 'accept',
    example: 'hold',
    category: 'misc',
  },
  {
    name: 'AFK_PEER_POLL_MS',
    description:
      'Polling interval in milliseconds for the peer inbox notifier when ' +
      'fs.watch is unavailable or unreliable. Default 1000.',
    type: 'number',
    required: false,
    default: '1000',
    example: '2000',
    category: 'misc',
  },
  {
    name: 'TMUX_PANE',
    description:
      'tmux pane identifier, set automatically by tmux inside any pane (e.g. %0). ' +
      'Used by AFK to target the correct pane when composing a tmux display-message label.',
    type: 'string',
    required: false,
    example: '%0',
    category: 'process',
  },
] as const satisfies readonly EnvVarMeta[];
