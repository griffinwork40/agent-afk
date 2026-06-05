/**
 * User-typed shell-passthrough subsystem (the `!cmd` / `!&cmd` REPL prefix).
 *
 * Two independently useful pieces:
 *   - `startShell` — streaming shell executor, returns a `ShellHandle`.
 *   - `ShellJobRegistry` — per-REPL job table with completion events,
 *     used to back the `/sh list|show|kill|tail` slash command and the
 *     REPL-exit drain.
 *
 * @module agent/shell-jobs
 */

export {
  startShell,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  type StartShellOptions,
  type ShellHandle,
  type ShellResult,
  type ShellErrorReason,
} from './streamer.js';

export {
  ShellJobRegistry,
  type ShellJob,
  type ShellJobStatus,
  type ShellJobRegistryEvents,
  type StartJobOptions,
} from './registry.js';
