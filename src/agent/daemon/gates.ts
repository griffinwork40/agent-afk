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
  | 'not-yet';

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
 * Delegates to {@link readTelemetryHistory} with `limit: 1` so I/O is bounded
 * to `tailBytes` (default 1 MiB) regardless of how large the telemetry file
 * has grown.
 */
export async function readLastTickTime(taskId: string, telemetryPath: string): Promise<number | null> {
  const records = await readTelemetryHistory(telemetryPath, { taskId, limit: 1 });
  if (records.length === 0) return null;
  const rec = records[records.length - 1] as { triggeredAt?: string } | null;
  if (!rec || typeof rec.triggeredAt !== 'string') return null;
  const ms = Date.parse(rec.triggeredAt);
  return Number.isNaN(ms) ? null : ms;
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
