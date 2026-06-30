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

import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_SESSIONSTART_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

export type SessionStartSkipReason = 'cooldown';

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
 * Scan the telemetry file for the most recent entry matching `taskId`.
 * Returns the `triggeredAt` timestamp in ms, or `null` if no prior fire.
 * Reads the entire file — fine at current scale (< 1 MB); revisit if the
 * file grows past tens of MB.
 */
export function readLastTickTime(taskId: string, telemetryPath: string): number | null {
  if (!existsSync(telemetryPath)) return null;
  let content: string;
  try {
    content = readFileSync(telemetryPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { taskId?: string; triggeredAt?: string };
      if (record.taskId !== taskId || typeof record.triggeredAt !== 'string') continue;
      const ms = Date.parse(record.triggeredAt);
      if (Number.isNaN(ms)) continue;
      return ms;
    } catch {
      continue;
    }
  }
  return null;
}

export function evaluateSessionStartGates(options: GateOptions): GateDecision {
  const lastFiredMs = readLastTickTime(options.taskId, options.telemetryPath);
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
