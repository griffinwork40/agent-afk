/**
 * Pull-mode tick logic extracted from scheduler.ts.
 *
 * Contains:
 *   - `sweepAnsweredHandoffs` — shared sweep helper (was copy-pasted ~4x)
 *   - `executePullTick`      — the full body of `CronScheduler.pullTick`
 *   - `fireOnTaskComplete`   — task-completion notification funnel
 *
 * `CronScheduler.pullTick` becomes a 5-line dispatcher that wires the class
 * state into `PullTickContext` and delegates here. Public API and runtime
 * behaviour are unchanged.
 *
 * @module agent/daemon/scheduler.pull-tick
 */

import { processAnsweredHandoffs } from './handoff-consume.js';
import { dequeueNext, enqueue, listPending } from './queue-store.js';
import { completeTask } from './lease-store.js';
import { pickResumeFields } from './handoff-resume-context.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';
import type { ScheduledTask } from './triggers.js';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';
import { errorMessage } from '../../utils/errors.js';

// ─── Context interface ────────────────────────────────────────────────────────

export interface PullTickContext {
  queueDir: string;
  /** Override the handoffs directory swept for answers (tests). */
  handoffsDir?: string;
  isIdle: () => boolean;
  getIsDequeuing: () => boolean;
  setIsDequeuing: (v: boolean) => void;
  runOnce: (task: ScheduledTask, trigger: 'pull') => Promise<TelemetryRecord>;
  /** True while a run holding this overlap key is in flight (scheduler.inFlightTasks). */
  isOverlapBusy?: (overlapKey: string) => boolean;
}

/**
 * Invariant: a resume task overlap-guards as its ORIGINAL task id (#1416). If
 * that task is running (e.g. a cron fire), dequeuing the resume would only
 * produce an overlap skip, so the tick is deferred instead. The check, the
 * dequeue, and runOnce's in-flight registration all run synchronously in one
 * turn of the event loop, so no cron fire can slip in between them.
 */
function resumeBlockedByOverlap(ctx: PullTickContext): boolean {
  const busy = ctx.isOverlapBusy;
  if (busy === undefined) return false;
  // Only the entry dequeueNext would pick next (first eligible, FIFO), so a
  // busy cron task never blocks unrelated queued work behind it.
  const now = Date.now();
  const next = listPending(ctx.queueDir).find((t) => t.eligibleAfter === undefined || t.eligibleAfter <= now);
  return next?.originalTaskId !== undefined && busy(next.originalTaskId);
}

// ─── Sweep helper ─────────────────────────────────────────────────────────────

/**
 * Process any answered handoffs in `queueDir`, logging re-enqueue counts and
 * errors to stderr. Fire-and-forget: the returned Promise is always void-cast
 * at call sites — this function is the single canonical implementation of the
 * four formerly copy-pasted sweep blocks.
 */
export function sweepAnsweredHandoffs(queueDir: string, handoffsDir?: string): void {
  void processAnsweredHandoffs(queueDir, handoffsDir)
    .then((r) => {
      if (r.requeued > 0) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] handoff-consume: re-enqueued ${r.requeued} answered handoff(s)`);
      }
    })
    .catch((err: unknown) => {
      const msg = errorMessage(err);
      // eslint-disable-next-line no-console
      console.error(`[daemon] handoff-consume: sweep failed: ${msg}`);
    });
}

// ─── Pull tick ────────────────────────────────────────────────────────────────

/**
 * Execute one pull-mode tick.
 *
 * Guards entry with the idle-detector and the dequeue mutex, dequeues the next
 * queued task (if any), runs it, finalises the lease, and sweeps answered
 * handoffs. Mirrors the former `CronScheduler.pullTick` private method exactly.
 *
 * Contract: `ctx.setIsDequeuing(false)` is called in a `finally` block so the
 * mutex is always released even when `runOnce` throws.
 */
export async function executePullTick(ctx: PullTickContext): Promise<void> {
  if (!ctx.isIdle()) return;
  if (ctx.getIsDequeuing()) return;
  if (resumeBlockedByOverlap(ctx)) return;
  ctx.setIsDequeuing(true);
  try {
    // ORDERING INVARIANT: file is removed by dequeueNext BEFORE runOnce
    // spawns a session — reverse order risks double-fire on daemon restart
    // if the process crashes between dequeue and spawn.
    const queued = dequeueNext(ctx.queueDir);
    if (queued === null) {
      // Queue is empty this tick — still sweep for answered handoffs. An
      // answer that arrives between ticks would otherwise wait indefinitely
      // if no other task completes to trigger the post-run sweep below.
      // Expiry is NOT swept here: handoff-maintenance.ts owns the periodic
      // expiry sweep for every trigger mode (#1416), so pull mode never
      // sweeps twice.
      sweepAnsweredHandoffs(ctx.queueDir, ctx.handoffsDir);
      return;
    }
    // A resume task (answered handoff, #1416) carries the asking task's
    // context: it spawns in that task's pinned cwd, notifies per its policy,
    // and overlap-guards as the ORIGINAL task id (the queue id stays the
    // taskId so lease bookkeeping below still targets this queue entry).
    const resume = pickResumeFields(queued);
    const syntheticTask: ScheduledTask = {
      taskId: queued.id,
      command: queued.command,
      trigger: 'pull',
      ...(queued.notifyOn !== undefined ? { notifyOn: queued.notifyOn } : {}),
      ...(resume.cwd !== undefined ? { cwd: resume.cwd } : {}),
      ...(resume.notifyChat !== undefined ? { notifyChat: resume.notifyChat } : {}),
      ...(resume.originalTaskId !== undefined ? { overlapKey: resume.originalTaskId } : {}),
    };
    const record = await ctx.runOnce(syntheticTask, 'pull');
    // Defense in depth for the deferral above: an overlap-skipped resume never
    // ran, so put it back rather than finalising it (which would drop the answer).
    if (record.skipReason === 'overlap') enqueue(queued.command, resume, ctx.queueDir);
    // Finalize the lease: move leased/<id>.json → completed/ so the task
    // does not appear as an expired lease on the next daemon restart.
    // Best-effort: a completeTask failure must never crash the pull loop.
    try {
      completeTask(
        queued.id,
        record.status === 'error' ? 'failed' : 'succeeded',
        record.errorMessage,
        ctx.queueDir,
      );
    } catch {
      // Non-fatal — the lease recovery path (recoverExpiredLeases on next
      // startup) will re-enqueue or dead-letter based on the record's attempts.
    }
    // If the session answered a handoff during this run, re-enqueue it now.
    sweepAnsweredHandoffs(ctx.queueDir, ctx.handoffsDir);
  } catch (err) {
    // Errors thrown INSIDE runOnce are captured there and written to
    // telemetry. Errors reaching here come from the dequeue path (now
    // quarantined inside dequeueNext) or from synthetic-task construction.
    // Log so a bad tick is visible in daemon logs instead of vanishing;
    // the poll loop still survives (mirrors writeTelemetry's logging path).
    // Redact error-derived text before logging, matching the runOnce
    // telemetry path (a synthetic task's command may carry an inline secret).
    const msg = redactInlineSecrets(errorMessage(err));
    // eslint-disable-next-line no-console
    console.error(`[daemon] pull tick failed: ${msg}`);
  } finally {
    ctx.setIsDequeuing(false);
  }
}

// ─── Task-completion notification funnel ──────────────────────────────────────

export interface FireOnTaskCompleteOptions {
  /**
   * Contract: the `record` argument reflects the in-memory TelemetryRecord that
   * was *attempted* to be written to disk. When the telemetry append throws, the
   * callback still fires with that record — the record may not be on disk.
   * Callers that require durability guarantees must verify the write independently.
   */
  onTaskComplete?: (record: TelemetryRecord, details?: TaskCompletionDetails) => void | Promise<void>;
}

/**
 * Invoke `options.onTaskComplete` when the task's `notifyOn` filter passes.
 *
 * Extracted from `CronScheduler.fireOnTaskComplete`. The scheduler's private
 * method is now a one-line delegation. Behaviour is unchanged.
 *
 * Contract: callback errors are swallowed and logged so a notification failure
 * never crashes the scheduler.
 */
export function fireOnTaskComplete(
  record: TelemetryRecord,
  options: FireOnTaskCompleteOptions,
  task?: ScheduledTask,
  details?: TaskCompletionDetails,
): void {
  const cb = options.onTaskComplete;
  if (!cb) return;
  // notifyOn filter — only applies when the triggering task is known
  if (task !== undefined) {
    if (task.notifyOn === 'never') return;
    // 'blocked' means a gate block without a trustworthy declared recovery.
    // Recovered success retains gateBlocks but is not a failure (#3756).
    if (task.notifyOn === 'failure' && record.status !== 'error' && record.status !== 'blocked') return;
    // 'always' or undefined (legacy behavior) falls through
  }
  // Thread the task's explicit chat target (if any) onto the details so the
  // injected callback can route the push. Merged here — rather than at every
  // writeTelemetry call site — because this is the single funnel every
  // completion path flows through, and the scheduler must not resolve/validate
  // the target itself (layering: no src/cli import). An explicit
  // details.notifyChat (should never happen today) is preserved.
  const effectiveDetails: TaskCompletionDetails | undefined =
    task?.notifyChat !== undefined
      ? { ...(details ?? {}), notifyChat: details?.notifyChat ?? task.notifyChat }
      : details;
  // Fire-and-forget. Notification callbacks must not block telemetry
  // writes or crash the scheduler — every error is swallowed and logged.
  try {
    const result = cb(record, effectiveDetails);
    if (result instanceof Promise) {
      void result.catch((err: unknown) => {
        const msg = errorMessage(err);
        // eslint-disable-next-line no-console
        console.error(`[daemon] onTaskComplete callback failed: ${msg}`);
      });
    }
  } catch (err) {
    const msg = errorMessage(err);
    // eslint-disable-next-line no-console
    console.error(`[daemon] onTaskComplete callback failed: ${msg}`);
  }
}

