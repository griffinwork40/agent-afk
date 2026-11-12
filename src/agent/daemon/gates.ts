/**
 * Gating helpers for Phase 6 sessionstart triggers.
 *
 * `evaluateSessionStartGates` decides whether a sessionstart fire should
 * proceed by checking the cooldown gate: has the task fired (on any trigger)
 * within `cooldownMs`? Read from the most recent telemetry entry for this
 * taskId.
 *
 * @module agent/daemon/gates
 */

import { readTelemetryHistory } from './telemetry-reader.js';

export const DEFAULT_SESSIONSTART_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

export type SessionStartSkipReason =
  | 'cooldown'
  | 'overlap'
  | 'budget-over'
  | 'telemetry-unwritable'
  /** Task has passed its `expiresAt` wall-clock deadline. */
  | 'expired'
  /** Task has a `runAt` that has not been reached yet. */
  | 'not-yet'
  /**
   * A stored `runAt` or `expiresAt` value is not a valid ISO 8601 string.
   * This can happen when `schedules.json` has been hand-edited. The task is
   * skipped and a warning is emitted so the operator knows to fix the value.
   */
  | 'malformed';

export interface GateDecision {
  fire: boolean;
  skipReason?: SessionStartSkipReason;
  lastFiredAtMs?: number;
  cooldownRemainingMs?: number;
}

export interface GateOptions {
  taskId: string;
  cooldownMs: number;
  nowMs: number;
  telemetryPath: string;
}

/**
 * Return the `triggeredAt` timestamp (ms) of the most recent telemetry entry
 * for `taskId`, or `null` when no prior fire is recorded.
 *
 * Delegates to {@link readTelemetryHistory} with `limit: 50` and walks
 * backwards to find the most recent record that is NOT a skip — quarantine
 * and malformed-gate telemetry (`status:'skipped'`) must not poison the
 * cooldown gate and suppress future real executions.
 *
 * A larger limit (50 vs the previous 10) prevents window exhaustion when a
 * task accumulates many consecutive `status:'skipped'` records (e.g. repeated
 * daemon restarts with a persistently broken task). See #4647.
 */
export async function readLastTickTime(taskId: string, telemetryPath: string): Promise<number | null> {
  const records = await readTelemetryHistory(telemetryPath, { taskId, limit: 50 });
  // Walk backwards (most recent first) to find the last record that was NOT
  // a skip — quarantine and malformed-gate telemetry must not reset cooldowns.
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i] as { triggeredAt?: string; status?: string } | null;
    if (!rec || rec.status === 'skipped') continue;
    if (typeof rec.triggeredAt !== 'string') continue;
    const ms = Date.parse(rec.triggeredAt);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

export async function evaluateSessionStartGates(options: GateOptions): Promise<GateDecision> {
  const lastFiredMs = await readLastTickTime(options.taskId, options.telemetryPath);
  if (lastFiredMs !== null && options.cooldownMs > 0) {
    const elapsed = options.nowMs - lastFiredMs;
    if (elapsed < options.cooldownMs) {
      return {
        fire: false,
        skipReason: 'cooldown',
        lastFiredAtMs: lastFiredMs,
        cooldownRemainingMs: options.cooldownMs - elapsed,
      };
    }
  }

  return {
    fire: true,
    ...(lastFiredMs !== null ? { lastFiredAtMs: lastFiredMs } : {}),
  };
}
