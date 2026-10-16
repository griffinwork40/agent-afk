/**
 * Contract: handoff maintenance for EVERY daemon trigger mode (#1416).
 * Cron, sessionstart, and both-mode tasks write pending handoffs
 * (`makeCronElicitationHandler`) just like pull tasks do, so the upkeep of
 * those records cannot live inside the pull loop. This module owns it:
 *
 *   - Startup (once): re-notify still-pending questions and expire stale ones
 *     (`recoverPendingHandoffs`), THEN restore expired leases in the resume
 *     queue (see `runStartupRecovery` for why the order matters).
 *   - Every tick (unref'd interval, cleared by the scheduler's `stop()`):
 *       1. throttled expiry sweep (`sweepExpiredHandoffs`, self-throttled to
 *          one walk per `EXPIRY_SWEEP_INTERVAL_MS`). This is the ONLY caller
 *          of the periodic sweep, so pull mode never sweeps twice.
 *       2. consume answered handoffs into the dedicated resume queue
 *          (`<queueDir>/handoff-resume`), then run at most one resume task
 *          from it through the scheduler's own `executePullTick` (idle
 *          detector, dequeue mutex, overlap/budget guards, lease finalise).
 *
 * Invariant: only resume tasks produced by `processAnsweredHandoffs` ever
 * land in the resume queue, so a non-pull daemon never starts draining the
 * general pull queue. The resume queue is a plain queue-store directory, so
 * a crash mid-resume is recovered by `recoverExpiredLeases` on next start.
 *
 * @module agent/daemon/handoff-maintenance
 */

import { join } from 'node:path';
import type { Telegraf } from 'telegraf';
import { recoverPendingHandoffs } from './handoff-wiring.js';
import { processAnsweredHandoffs } from './handoff-consume.js';
import { RESUME_QUEUE_SUBDIR, sweepExpiredHandoffs } from './handoff-expiry.js';
import { recoverExpiredLeases } from './lease-store.js';
import { errorMessage } from '../../utils/errors.js';

/** Cadence of the maintenance tick (answer pickup latency). */
export const HANDOFF_MAINTENANCE_INTERVAL_MS = 30_000;

export { RESUME_QUEUE_SUBDIR };

/** The resume-queue directory for a daemon queue root. */
export function resumeQueueDir(queueDir: string): string {
  return join(queueDir, RESUME_QUEUE_SUBDIR);
}

export interface HandoffMaintenanceOpts {
  /** Daemon queue root (lease restore on expiry targets this dir). */
  queueDir: string;
  /** Override the handoffs directory (tests). */
  handoffsDir?: string;
  /** Telegraf instance for rich re-notification on startup, when co-hosted. */
  bot?: Telegraf;
  /**
   * Run at most one queued task from `resumeDir`. The scheduler binds this to
   * `executePullTick` so resumes share its idle/mutex/overlap guards.
   */
  drainResumeQueue: (resumeDir: string) => Promise<void>;
  /** Tick interval override (defaults to `HANDOFF_MAINTENANCE_INTERVAL_MS`). */
  intervalMs?: number;
}

export interface HandoffMaintenanceHandle {
  /**
   * Clear the periodic maintenance interval and await the one-shot startup
   * recovery that was fired on construction. Awaiting `stop()` guarantees no
   * further writes into `queueDir` can race a subsequent directory removal
   * (e.g. `rmSync(tmpHome, { recursive: true })` in test teardown). Safe to
   * call multiple times — idempotent after the first call.
   */
  stop(): Promise<void>;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`[daemon] handoff-maintenance: ${msg}`);
}

/**
 * Invariant: handoff recovery (re-notify + expiry) runs BEFORE the resume
 * queue's lease recovery. Expiring a handoff moves a lease parked in
 * 'waiting_human_input' back to 'leased'; `recoverExpiredLeases` skips parked
 * leases, so running it first would leave that lease stranded until the next
 * daemon restart.
 */
export async function runStartupRecovery(opts: HandoffMaintenanceOpts, resumeDir: string): Promise<void> {
  try {
    const r = await recoverPendingHandoffs(opts.handoffsDir, opts.queueDir, opts.bot);
    if (r.renotified > 0 || r.expired > 0) log(`re-notified ${r.renotified}, expired ${r.expired}`);
  } catch (err) {
    log(`recovery failed: ${errorMessage(err)}`);
  }
  try {
    const recovered = recoverExpiredLeases(resumeDir);
    if (recovered.length > 0) log(`recovered ${recovered.length} expired resume lease(s)`);
  } catch (err) {
    log(`resume lease recovery failed: ${errorMessage(err)}`);
  }
}

/** Consume answered handoffs into the resume queue, then run one resume task. */
export async function consumeAndResume(opts: HandoffMaintenanceOpts, resumeDir: string): Promise<void> {
  try {
    const r = await processAnsweredHandoffs(resumeDir, opts.handoffsDir);
    if (r.requeued > 0) log(`queued ${r.requeued} answered handoff(s) for resume`);
  } catch (err) {
    log(`answer sweep failed: ${errorMessage(err)}`);
  }
  try {
    await opts.drainResumeQueue(resumeDir);
  } catch (err) {
    log(`resume run failed: ${errorMessage(err)}`);
  }
}

/**
 * Run startup recovery once and start the periodic maintenance tick.
 * The returned handle's `stop()` clears the interval AND awaits the one-shot
 * startup-recovery promise so callers can be certain no further writes into
 * `queueDir` are in flight after `stop()` resolves — preventing the macOS
 * ENOTEMPTY race in test teardown when `queueDir` is inside a temp directory
 * that is removed synchronously right after `stop()` (#3925).
 */
export function startHandoffMaintenance(opts: HandoffMaintenanceOpts): HandoffMaintenanceHandle {
  const resumeDir = resumeQueueDir(opts.queueDir);
  // Keep a reference to the startup promise so stop() can await it.
  const startupRecovery = runStartupRecovery(opts, resumeDir);
  let resuming = false;
  const timer = setInterval(() => {
    // Expiry runs every tick, even while a long resume run is in progress.
    sweepExpiredHandoffs(opts.queueDir, Date.now(), opts.handoffsDir);
    if (resuming) return;
    resuming = true;
    void consumeAndResume(opts, resumeDir).finally(() => { resuming = false; });
  }, opts.intervalMs ?? HANDOFF_MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      // Await the startup recovery so no in-flight writes race a subsequent
      // directory removal by the caller (e.g. test teardown rmSync). The
      // promise is already settled in the happy path; this is a no-op then.
      await startupRecovery;
    },
  };
}
