/**
 * Telemetry-write-guard for sessionstart tasks.
 *
 * A failed `appendFileSync` in `writeTelemetry` silently drops the fire-time
 * record. On the next daemon restart `readLastTickTime` returns `null` (no
 * record), so the cooldown gate passes and the task re-fires, costing real
 * tokens on every restart.
 *
 * This module provides two defences, both called from
 * `CronScheduler.fireOnStart` **before** any `executor:'agent'` task is
 * dispatched:
 *
 * 1. `probeTelemetryWritable` — synchronous `accessSync(W_OK)` probe. Returns
 *    `null` when the file is writable (or does not exist yet — a fresh install
 *    where the file will be created on the first write). Returns an error
 *    string when the file exists AND is not writable.
 *
 * 2. `TelemetryAlertLatch` — a per-daemon-process latch, analogous to
 *    `BudgetAlertLatch`, that fires at most ONE Telegram alert per process
 *    lifetime when a non-writable telemetry file is detected. The alert is
 *    sent via `pushIfConfigured` (fire-and-forget; never throws).
 *
 * Callers receive the guard result and decide whether to skip the task. A
 * `skipped` telemetry record with `skipReason: 'telemetry-unwritable'` is
 * written by the caller so the skip is visible in session history (the record
 * is written to a *different* sink if the primary path is broken — the caller
 * owns that decision).
 *
 * Layering: `src/agent/daemon/` → `src/telegram/push.js` is already
 * established by `handoff-wiring.ts`.
 *
 * @module agent/daemon/telemetry-write-guard
 */

import { existsSync, accessSync, constants } from 'node:fs';
import { pushIfConfigured } from '../../telegram/push.js';

// ─── Writability probe ────────────────────────────────────────────────────────

/**
 * Synchronously probe whether the telemetry file is writable.
 *
 * - Returns `null`  → safe to proceed (file absent or writable).
 * - Returns a string → the errno / message explaining why it is not writable.
 *
 * We only gate when the file already exists AND is not writable, because:
 *   a) A missing file will be created on first write (not a concern).
 *   b) A read-only file that already holds prior records is exactly the
 *      failure case: the gate read will return a stale last-fired time,
 *      making the cooldown check unreliable if/when the disk recovers.
 */
export function probeTelemetryWritable(telemetryPath: string): string | null {
  if (!existsSync(telemetryPath)) return null;
  try {
    accessSync(telemetryPath, constants.W_OK);
    return null; // writable
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = (err as NodeJS.ErrnoException).message ?? String(err);
    return code != null ? `${code}: ${message}` : message;
  }
}

// ─── Alert latch ──────────────────────────────────────────────────────────────

/**
 * One Telegram alert per daemon process when a non-writable telemetry file is
 * detected at startup.
 *
 * Modelled after `BudgetAlertLatch`: the first detection fires; subsequent
 * detections in the same process are silently swallowed so a telemetry issue
 * does not spam the operator on every daemon restart.
 *
 * A daemon restart is a new process, so the latch resets — the operator is
 * notified once per restart, which is the intended trade-off (never silent
 * after a restart, never a flood within a session).
 */
export class TelemetryAlertLatch {
  private alerted = false;

  /**
   * Send a Telegram alert for a non-writable telemetry file if this latch has
   * not already fired in this process lifetime.
   *
   * Fire-and-forget: the returned Promise is void-cast by the caller so a
   * Telegram misconfiguration never blocks the scheduler.
   *
   * @param telemetryPath  The path that failed the W_OK probe.
   * @param errno          The error string returned by `probeTelemetryWritable`.
   */
  async notify(telemetryPath: string, errno: string): Promise<void> {
    if (this.alerted) return;
    this.alerted = true;
    const text =
      `[daemon] Telemetry file is not writable — sessionstart agent tasks will be skipped.\n` +
      `Path: ${telemetryPath}\n` +
      `Error: ${errno}\n` +
      `Fix the file permissions or disk issue and restart the daemon. ` +
      `Cooldown records cannot be saved while the file is unwritable, so tasks ` +
      `would re-fire on every restart if allowed to run.`;
    await pushIfConfigured(text).catch(() => undefined);
  }

  /** Exposed for tests: reset the latch between test cases. */
  _reset(): void {
    this.alerted = false;
  }
}
