/**
 * Pure option resolvers for the `daemon` command. Kept free of
 * `process` / `commander` access so they can be unit-tested.
 * @module cli/daemon-options
 */

import type { TriggerMode } from '../agent/daemon/triggers.js';

/**
 * Resolve the per-tick session timeout from (in precedence order):
 *   1. `--timeout-ms` flag value
 *   2. `AFK_TIMEOUT_MS` env var value
 *   3. `undefined` — lets `sessionConfig.timeoutMs` fall through to
 *      the session's built-in default.
 *
 * Throws if the resolved raw value is not a positive finite integer.
 */
export function resolveDaemonTimeoutMs(
  flagValue: string | undefined,
  envValue: string | undefined,
): number | undefined {
  const raw = flagValue ?? envValue;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid timeout-ms: '${raw}' — must be a positive integer (milliseconds).`,
    );
  }
  return parsed;
}

/**
 * Resolve the Phase 6 sessionstart cooldown from (in precedence order):
 *   1. `--sessionstart-cooldown-ms` flag
 *   2. `AFK_SESSIONSTART_COOLDOWN_MS` env var
 *   3. `undefined` — lets the scheduler's `DEFAULT_SESSIONSTART_COOLDOWN_MS`
 *      (6h) apply.
 *
 * Accepts `0` to disable the cooldown entirely. Rejects negatives,
 * floats, `NaN`, `Infinity`, and non-numeric input.
 */
export function resolveSessionStartCooldownMs(
  flagValue: string | undefined,
  envValue: string | undefined,
): number | undefined {
  const raw = flagValue ?? envValue;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid sessionstart-cooldown-ms: '${raw}' — must be a non-negative integer (milliseconds).`,
    );
  }
  return parsed;
}

/**
 * Resolve the daemon trigger mode.
 *
 * When neither `--trigger` nor `--cron` are supplied the daemon defaults to
 * `'sessionstart'` so that `afk daemon` (no flags) is immediately runnable
 * without a cron expression. Callers that pass `--cron` but omit
 * `--trigger` still get `'cron'` as before. Explicit `--trigger` always
 * wins. Rejects unknown values.
 *
 * Precedence:
 *   1. `--trigger` flag (explicit)
 *   2. `'cron'` when `--cron` is provided but `--trigger` is not
 *   3. `'sessionstart'` when neither flag is present (zero-config default)
 */
export function resolveTriggerMode(
  flagValue: string | undefined,
  cronFlag?: string | undefined,
): TriggerMode {
  if (flagValue !== undefined && flagValue !== '') {
    if (flagValue === 'cron' || flagValue === 'sessionstart' || flagValue === 'both' || flagValue === 'pull') {
      return flagValue;
    }
    throw new Error(
      `Invalid trigger: '${flagValue}' — must be one of cron | sessionstart | both | pull.`,
    );
  }
  // No explicit --trigger: infer from whether --cron was supplied.
  // External constraint: cron trigger requires a cronExpression at
  // registration time (validateScheduledTask enforces this); defaulting
  // to sessionstart avoids a mandatory flag for the zero-config case.
  return cronFlag !== undefined && cronFlag !== '' ? 'cron' : 'sessionstart';
}

/**
 * Compiled-in default daemon task slash command.
 *
 * Empty by design: the daemon must not fabricate a task when the user
 * configured none. Supply a task via --task, the AFK_DAEMON_TASK env var, or
 * `daemon.task` in afk.config.json; the cron and both triggers require one
 * (enforced in registerDaemonCommand). This previously defaulted to an
 * internal-only skill, which a build lacking that skill could not run.
 */
export const COMPILED_DEFAULT_TASK = '';

/**
 * Compiled-in default daemon task ID. Used when no flag, env var, or
 * config value is provided.
 */
export const COMPILED_DEFAULT_TASK_ID = 'default';

/**
 * Treat empty strings and whitespace-only strings as absent so that
 * downstream precedence falls through to the next source.
 */
function presentOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '') return undefined;
  return value;
}

/**
 * Resolve the daemon's default task slash command from (in precedence
 * order):
 *   1. `--task` flag value
 *   2. `AFK_DAEMON_TASK` env var value
 *   3. config value (`afk.config.json`)
 *   4. {@link COMPILED_DEFAULT_TASK} fallback
 *
 * Empty / whitespace-only inputs are treated as absent.
 */
export function resolveDefaultTask(
  flagValue: string | undefined,
  envValue: string | undefined,
  configValue: string | undefined,
): string {
  return (
    presentOrUndefined(flagValue) ??
    presentOrUndefined(envValue) ??
    presentOrUndefined(configValue) ??
    COMPILED_DEFAULT_TASK
  );
}

/**
 * Resolve the daemon's default task ID from (in precedence order):
 *   1. `--task-id` flag value
 *   2. `AFK_DAEMON_TASK_ID` env var value
 *   3. config value (`afk.config.json`)
 *   4. {@link COMPILED_DEFAULT_TASK_ID} fallback
 *
 * Empty / whitespace-only inputs are treated as absent.
 */
export function resolveDefaultTaskId(
  flagValue: string | undefined,
  envValue: string | undefined,
  configValue: string | undefined,
): string {
  return (
    presentOrUndefined(flagValue) ??
    presentOrUndefined(envValue) ??
    presentOrUndefined(configValue) ??
    COMPILED_DEFAULT_TASK_ID
  );
}

/**
 * Compiled-in default daemon control-surface bind host. Loopback only.
 *
 * The HTTP control surface is unauthenticated and POST /tasks schedules
 * commands the daemon executes, so the safe default is to refuse off-host
 * connections. Override via --host / AFK_DAEMON_HOST only when remote control
 * is genuinely needed (and the port is firewalled).
 */
export const DEFAULT_DAEMON_HOST = '127.0.0.1';

/**
 * Resolve the daemon control-surface bind host from (in precedence order):
 *   1. `--host` flag value
 *   2. `AFK_DAEMON_HOST` env var value
 *   3. {@link DEFAULT_DAEMON_HOST} ('127.0.0.1') fallback
 *
 * Empty / whitespace-only inputs are treated as absent.
 */
export function resolveDaemonHost(
  flagValue: string | undefined,
  envValue: string | undefined,
): string {
  return (
    presentOrUndefined(flagValue) ??
    presentOrUndefined(envValue) ??
    DEFAULT_DAEMON_HOST
  );
}

/**
 * True when `host` binds only the local machine (loopback). Used to decide
 * whether to warn that the unauthenticated control surface is reachable from
 * the network. Anything that is not a recognised loopback literal — including
 * the all-interfaces wildcards '0.0.0.0' and '::' and any LAN IP/hostname — is
 * treated as non-loopback (warn).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
