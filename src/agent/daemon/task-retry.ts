/**
 * Optional in-process retry for daemon cron tasks (#3243 gap 3).
 *
 * A scheduled agent task may set `maxAttempts` (default 1 = no retry, exactly
 * the pre-#3243 behaviour) and `retryDelayMs` (backoff base). When an attempt
 * fails with a CLASSIFIED-TRANSIENT error (429, network blip, provider 5xx —
 * the same `isTransientError` predicate the one-shot model-call retry uses),
 * the same run is retried in-process with exponential backoff
 * (`computeBackoffMs`, capped at `TASK_RETRY_DELAY_MAX_MS`). Non-transient
 * failures return immediately on the first attempt.
 *
 * Contract: the caller holds the scheduler's per-task in-flight guard for the
 * whole loop (attempts AND backoff waits), so a cron tick that lands during a
 * retry is recorded as an overlap skip rather than stacking a second run.
 * The loop never starts a new attempt once `signal` is aborted (daemon
 * shutdown) or `isCancelled()` reports the task was unregistered/replaced; an
 * abort during a backoff wait ends the wait immediately (`sleepWithAbort`).
 *
 * Bounds (`parseTaskRetryFields`) are enforced at the input surfaces (agent
 * tools, daemon HTTP route, web API). The runtime only normalizes defensively
 * (`resolveTaskRetryPolicy`) so a hand-edited schedules.json cannot make the
 * daemon loop unboundedly.
 *
 * @module agent/daemon/task-retry
 */

import { isTransientError } from '../providers/shared/transient-retry.js';
import { parseRetryAfterMs } from '../providers/shared/retry-after.js';
import { sleepWithAbort } from '../providers/shared/sleep-with-abort.js';
import {
  computeBackoffMs,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from './task-lifecycle.js';

/** Upper bound on `maxAttempts` (total attempts, including the first). */
export const TASK_MAX_ATTEMPTS_LIMIT = 5;
/** Lower bound on a user-supplied `retryDelayMs`. */
export const TASK_RETRY_DELAY_MIN_MS = 1_000;
/** Upper bound on `retryDelayMs` and on any single computed backoff wait. */
export const TASK_RETRY_DELAY_MAX_MS = DEFAULT_MAX_BACKOFF_MS;
/** Backoff base used when `maxAttempts > 1` but `retryDelayMs` is omitted. */
export const DEFAULT_TASK_RETRY_DELAY_MS = DEFAULT_RETRY_POLICY.backoffBaseMs;

/** The optional retry fields carried by schedule configs and tasks. */
export interface TaskRetryFields {
  maxAttempts?: number;
  retryDelayMs?: number;
}

export type ParseTaskRetryResult =
  | { ok: true; value: TaskRetryFields }
  | { ok: false; error: string };

/**
 * Validate the optional `maxAttempts` / `retryDelayMs` fields of an input
 * object. Absent or `null` fields are omitted from the result. Present fields
 * must be integers within bounds; anything else is rejected, never coerced.
 */
export function parseTaskRetryFields(obj: Record<string, unknown>): ParseTaskRetryResult {
  const value: TaskRetryFields = {};
  const rawAttempts = obj['maxAttempts'];
  if (rawAttempts !== undefined && rawAttempts !== null) {
    if (!Number.isInteger(rawAttempts) || (rawAttempts as number) < 1 || (rawAttempts as number) > TASK_MAX_ATTEMPTS_LIMIT) {
      return { ok: false, error: `maxAttempts must be an integer between 1 and ${TASK_MAX_ATTEMPTS_LIMIT}` };
    }
    value.maxAttempts = rawAttempts as number;
  }
  const rawDelay = obj['retryDelayMs'];
  if (rawDelay !== undefined && rawDelay !== null) {
    if (!Number.isInteger(rawDelay) || (rawDelay as number) < TASK_RETRY_DELAY_MIN_MS || (rawDelay as number) > TASK_RETRY_DELAY_MAX_MS) {
      return {
        ok: false,
        error: `retryDelayMs must be an integer between ${TASK_RETRY_DELAY_MIN_MS} and ${TASK_RETRY_DELAY_MAX_MS}`,
      };
    }
    value.retryDelayMs = rawDelay as number;
  }
  return { ok: true, value };
}

/** Normalized runtime retry policy for one task. */
export interface ResolvedTaskRetry {
  maxAttempts: number;
  retryDelayMs: number;
}

/**
 * Defensive runtime normalization. Invalid/absent `maxAttempts` → 1 (no
 * retry); oversized values are clamped to the limits. No lower clamp on the
 * delay: input surfaces enforce `TASK_RETRY_DELAY_MIN_MS`, and tests drive
 * the scheduler with millisecond delays.
 */
export function resolveTaskRetryPolicy(task: TaskRetryFields): ResolvedTaskRetry {
  const a = task.maxAttempts;
  const maxAttempts = typeof a === 'number' && Number.isInteger(a) && a >= 1
    ? Math.min(a, TASK_MAX_ATTEMPTS_LIMIT)
    : 1;
  const d = task.retryDelayMs;
  const retryDelayMs = typeof d === 'number' && Number.isFinite(d) && d >= 0
    ? Math.min(d, TASK_RETRY_DELAY_MAX_MS)
    : DEFAULT_TASK_RETRY_DELAY_MS;
  return { maxAttempts, retryDelayMs };
}

export interface TaskRetryRunOptions extends ResolvedTaskRetry {
  /** Daemon shutdown signal. Aborting it ends a backoff wait immediately. */
  signal: AbortSignal;
  /** True when the task was unregistered/replaced; no further attempt starts. */
  isCancelled?: () => boolean;
  /** Injected sleep (tests). Defaults to `sleepWithAbort`. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called after a failed attempt that will be retried, before the backoff sleep. */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

export type TaskRetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number };

/**
 * Run `attempt` up to `maxAttempts` times, retrying only classified-transient
 * failures. Never throws: the terminal outcome (with the attempt count) is
 * returned so the caller writes exactly one telemetry record per run.
 */
export async function runWithTaskRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  opts: TaskRetryRunOptions,
): Promise<TaskRetryOutcome<T>> {
  const policy: RetryPolicy = {
    maxAttempts: opts.maxAttempts,
    backoffStrategy: 'exponential',
    backoffBaseMs: opts.retryDelayMs,
    maxBackoffMs: TASK_RETRY_DELAY_MAX_MS,
  };
  const sleep = opts.sleep ?? sleepWithAbort;
  const stopped = (): boolean => opts.signal.aborted || (opts.isCancelled?.() ?? false);
  for (let n = 1; ; n++) {
    try {
      return { ok: true, value: await attempt(n), attempts: n };
    } catch (error) {
      if (n >= policy.maxAttempts || !isTransientError(error) || stopped()) {
        return { ok: false, error, attempts: n };
      }
      // A server-mandated wait at or above our ceiling (e.g. a usage-limit
      // 429) cannot be served inside one run — give up instead of stalling.
      const hint = parseRetryAfterMs(error);
      if (hint !== undefined && hint >= TASK_RETRY_DELAY_MAX_MS) {
        return { ok: false, error, attempts: n };
      }
      const delayMs = Math.max(computeBackoffMs(n, policy), hint ?? 0);
      opts.onRetry?.({ attempt: n, error, delayMs });
      await sleep(delayMs, opts.signal);
      if (stopped()) return { ok: false, error, attempts: n };
    }
  }
}
