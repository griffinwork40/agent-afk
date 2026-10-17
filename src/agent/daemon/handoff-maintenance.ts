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
  /**
   * Optional: recover expired leases from the main pull queue after handoff
   * recovery completes. Pull-mode daemons pass `recoverDaemonQueues` here so
   * the main-queue lease recovery runs AFTER `recoverPendingHandoffs` (which
   * unparks waiting_human_input leases), matching the ordering already used for
   * the resume queue in `runStartupRecovery`.
   */
  recoverMainQueue?: () => void;
  /**
   * Optional in-flight predicate from the scheduler's per-task map.
   * Passed through to `expireHandoff` via `sweepExpiredHandoffs` so that a
   * restored lease is not reclaimed while the task is still executing.
   * See `ExpireHandoffOpts.isInFlight` for the full rationale.
   */
  isInFlight?: (taskId: string) => boolean;
  /** Tick interval override (defaults to `HANDOFF_MAINTENANCE_INTERVAL_MS`). */
  intervalMs?: number;
}

export interface HandoffMaintenanceHandle {
  stop(): void;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`[daemon] handoff-maintenance: ${msg}`);
}

/**
 * Invariant: handoff recovery (re-notify + expiry) runs BEFORE any lease
 * recovery. Expiring a handoff moves a lease parked in 'waiting_human_input'
 * back to 'leased'; `recoverExpiredLeases` skips parked leases, so running it
 * first would leave that lease stranded until the next daemon restart.
 *
 * Order: recoverPendingHandoffs → recoverExpiredLeases(resumeDir) →
 *        opts.recoverMainQueue() (main pull queue, pull-mode only).
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
  if (opts.recoverMainQueue !== undefined) {
    try {
      opts.recoverMainQueue();
    } catch (err) {
      log(`main queue recovery failed: ${errorMessage(err)}`);
    }
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
 * The returned handle's `stop()` clears the interval.
 */
export function startHandoffMaintenance(opts: HandoffMaintenanceOpts): HandoffMaintenanceHandle {
  const resumeDir = resumeQueueDir(opts.queueDir);
  void runStartupRecovery(opts, resumeDir);
  let resuming = false;
  const timer = setInterval(() => {
    // Expiry runs every tick, even while a long resume run is in progress.
    sweepExpiredHandoffs(opts.queueDir, Date.now(), opts.handoffsDir, opts.isInFlight);
    if (resuming) return;
    resuming = true;
    void consumeAndResume(opts, resumeDir).finally(() => { resuming = false; });
  }, opts.intervalMs ?? HANDOFF_MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
