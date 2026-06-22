/**
 * Gating helpers for Phase 6 sessionstart triggers.
 *
 * `evaluateSessionStartGates` decides whether a sessionstart fire should
 * proceed by checking two gates:
 *   1. Cooldown — has the task fired (on any trigger) within `cooldownMs`?
 *      Read from the most recent telemetry entry for this taskId.
 *   2. Brief queue — are there any pending briefs under `briefsDir`? If so,
 *      coordinate with `forge_brief_nudge` and skip fire so briefs are
 *      consumed before more are generated.
 *
 * @module agent/daemon/gates
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { getBriefsDir } from '../../paths.js';

export const DEFAULT_SESSIONSTART_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

export function defaultBriefsDir(): string {
  return getBriefsDir();
}

export type SessionStartSkipReason = 'cooldown' | 'briefs_pending';

export interface GateDecision {
  fire: boolean;
  skipReason?: SessionStartSkipReason;
  lastFiredAtMs?: number;
  cooldownRemainingMs?: number;
  pendingBriefCount?: number;
}

export interface GateOptions {
  taskId: string;
  cooldownMs: number;
  nowMs: number;
  telemetryPath: string;
  briefsDir: string;
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

/**
 * Count pending briefs in `briefsDir`. A "brief" is a top-level regular `.md`
 * file; subdirectories (notably the `consumed/` and `failed/` lifecycle bins,
 * which persist once any brief has been processed) and non-`.md` files are
 * ignored. Missing directory returns 0.
 *
 * Mirrors the brief detection in `pendingBriefContext`
 * (agent/routing-directive.ts) so the daemon's sessionstart gate and the
 * system-prompt nudge agree on the count. A bare `readdirSync(...).filter(name
 * => !name.startsWith('.'))` would count `consumed/`/`failed/` as pending
 * briefs and permanently trip the `briefs_pending` skip.
 */
export function countPendingBriefs(briefsDir: string): number {
  if (!existsSync(briefsDir)) return 0;
  try {
    return readdirSync(briefsDir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.md'),
    ).length;
  } catch {
    return 0;
  }
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

  const pendingBriefs = countPendingBriefs(options.briefsDir);
  if (pendingBriefs > 0) {
    return {
      fire: false,
      skipReason: 'briefs_pending',
      pendingBriefCount: pendingBriefs,
      ...(lastFiredMs !== null ? { lastFiredAtMs: lastFiredMs } : {}),
    };
  }

  return {
    fire: true,
    ...(lastFiredMs !== null ? { lastFiredAtMs: lastFiredMs } : {}),
  };
}
