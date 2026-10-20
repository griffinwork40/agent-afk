/**
 * TTY trace recorder env var. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted as its own sub-module so the single new entry does not bloat
 * `env.debug.ts` and keeps the registry split auditable.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.tty-trace
 */

import type { EnvVarMeta } from './env.js';

export const TTY_TRACE_ENV_REGISTRY = [
  {
    name: 'TERM',
    description:
      'Terminal type (e.g. xterm-256color). Recorded verbatim in the asciinema v2 cast header ' +
      'written by AFK_TTY_TRACE for replay fidelity. Standard POSIX var; not AFK-specific.',
    type: 'string',
    required: false,
    category: 'process',
  },
  {
    name: 'AFK_TTY_TRACE',
    description:
      'Absolute path for the asciinema v2 cast file the interactive REPL writes when ' +
      'stdout is a TTY. Every byte sent to stdout/stderr is tee-d to this file in real ' +
      'time using a sync fd so a crash loses nothing. Terminal resize events are recorded ' +
      'as resize ("r") events. Unset (the default) means off with zero overhead. ' +
      'Use to capture a reproducer for stale-row rendering bugs in tmux/multiplexer ' +
      'sessions. Replay with: pnpm exec tsx scripts/tty-replay.ts <cast>',
    type: 'string',
    required: false,
    example: '~/afk-tty.cast',
    category: 'debug',
  },
] as const satisfies readonly EnvVarMeta[];
