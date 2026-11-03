/**
 * Locked expiry for daemon handoff records (#1416).
 *
 * A daemon task that calls ask_question writes a pending HandoffRecord and
 * then declines, so its run finishes and its lease is archived. The record
 * is the only thing still waiting. Before this module, a pending record only
 * expired inside `recoverPendingHandoffs`, which runs once at daemon startup.
 * On a long-lived daemon a question could stay 'pending' for days: a late
 * answer would still resume the task, and the operator was never told the
 * question had lapsed.
 *
 * Two entry points:
 *   - `expireHandoff` — expire ONE record under the handoff lock. Shared by the
 *     startup recovery loop and the periodic sweep, so there is one expiry
 *     implementation.
 *   - `sweepExpiredHandoffs` — throttled, fire-and-forget sweep called from the
 *     handoff maintenance tick (every trigger mode). It never re-notifies
 *     pending questions (that stays a startup-only action in
 *     `recoverPendingHandoffs`).
 *
 * Invariant: the pending → expired transition happens inside
 * `withHandoffLock`, after a re-read that requires status 'pending'. This is
 * the same lock `updateHandoffAnswer` takes, so an answer and an expiry for
 * the same task are serialised: whichever takes the lock first wins, and the
 * loser sees a non-pending status and does nothing. Writing an expired copy of
 * a record read before the lock would silently erase an answer that landed in
 * between.
 *
 * Invariant: the lease is moved back to 'leased' only when it is still in
 * 'waiting_human_input' (an expected-state check), so expiry can never clobber
 * a lease another path has already moved on. In the normal path the lease was
 * already archived when the run finished and this is a no-op; it matters only
 * when the daemon crashed mid-run with the lease still parked.
 *
 * @module agent/daemon/handoff-expiry
 */

import { join } from 'node:path';
import { getHandoffsDir, getQueueDir } from '../../paths.js';
import {
  listPendingHandoffs,
  readHandoff,
  withHandoffLock,
  writeHandoff,
  type HandoffRecord,
} from './handoff-store.js';
import { setLeaseState } from './lease-store.js';
import { reclaimSingleLease } from './lease-reclaim.js';
import { operatorNotify } from '../operator-notify.js';
import { isChatAllowed, parseAllowedChatIds } from '../../telegram/allowlist.js';
import { env } from '../../config/env.js';
import { errorMessage } from '../../utils/errors.js';

/**
 * Queue subdirectory holding answered-handoff resume tasks. Declared here (not
 * in handoff-maintenance.ts) so expiry can restore a lease parked there
 * without an import cycle.
 */
export const RESUME_QUEUE_SUBDIR = 'handoff-resume';

/** Default TTL for daemon handoffs: 24 hours. */
export const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1_000;

/** Minimum gap between two periodic expiry sweeps. */
export const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

/** Cap on the question text echoed in the expiry notice. */
const MAX_NOTICE_CHARS = 300;

export interface ExpireHandoffOpts {
  /** Override the handoffs directory (defaults to `getHandoffsDir()`). */
  handoffsDir?: string;
  /** Queue root used for the crash-path lease restore. */
  queueDir?: string;
  /** TTL in ms (defaults to `DEFAULT_HANDOFF_TTL_MS`). */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: number;
  /**
   * Optional in-flight predicate threaded from the scheduler's per-task map.
   * When provided and it returns true for the restored lease's task id, the
   * lease is left in place — the task is still executing and must not be
   * reclaimed (renewLease has no production caller, so any task running longer
   * than the 10-minute lease TTL has leaseExpiry < now; sweeping the whole dir
   * with recoverExpiredLeases would double-run it).
   */
  isInFlight?: (taskId: string) => boolean;
}

/**
 * Whether a record is older than the TTL. An unparseable `createdAt` is never
 * stale (matches the pre-existing behaviour: NaN age never exceeds the TTL).
 */
export function isHandoffStale(
  record: Pick<HandoffRecord, 'createdAt'>,
  now: number,
  ttlMs: number = DEFAULT_HANDOFF_TTL_MS,
): boolean {
  const created = Date.parse(record.createdAt);
  if (!Number.isFinite(created)) return false;
  return now - created > ttlMs;
}

/**
 * Expire one pending handoff if it is past its TTL.
 *
 * @returns true when this call performed the pending → expired transition;
 *   false when the record is missing, no longer pending, not yet stale, or
 *   the lock is held by a concurrent answer/expiry.
 */
export async function expireHandoff(
  taskId: string,
  opts: ExpireHandoffOpts = {},
): Promise<boolean> {
  const dir = opts.handoffsDir ?? getHandoffsDir();
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;

  const expired = await withHandoffLock(taskId, dir, async () => {
    const fresh = await readHandoff(taskId, dir);
    if (fresh === null || fresh.status !== 'pending') return null;
    if (!isHandoffStale(fresh, now, ttlMs)) return null;
    const next: HandoffRecord = {
      ...fresh,
      status: 'expired',
      expiredAt: new Date(now).toISOString(),
    };
    await writeHandoff(next, dir);
    return fresh;
  });
  if (expired === null) return false;

  // Crash path only: a lease still parked in waiting_human_input goes back to
  // 'leased' and is immediately reclaimed (re-enqueued or dead-lettered) for
  // THIS ONE task. Safe outside the handoff lock: the record is already
  // non-pending, so no answer can land.
  // A resumed task's lease lives in the resume queue (handoff-maintenance.ts),
  // so try both; task ids are unique, so at most one lease matches.
  //
  // IMPORTANT: do NOT call recoverExpiredLeases(dir) here. renewLease has no
  // production caller, so any task running longer than the 10-minute lease TTL
  // has leaseExpiry < now and would be reclaimed mid-run and double-run.
  // reclaimSingleLease targets only the one restored lease and skips it when
  // the scheduler's isInFlight predicate reports the task is still executing.
  const root = opts.queueDir ?? getQueueDir();
  for (const dir of [root, join(root, RESUME_QUEUE_SUBDIR)]) {
    try {
      const restored = setLeaseState(taskId, 'leased', dir, 'waiting_human_input');
      if (restored) {
        try {
          reclaimSingleLease(taskId, dir, opts.isInFlight);
        } catch (recoverErr) {
          // eslint-disable-next-line no-console
          console.error(`[handoff-expiry] lease reclaim failed for task ${taskId}: ${errorMessage(recoverErr)}`);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[handoff-expiry] lease restore failed for task ${taskId}: ${errorMessage(err)}`);
    }
  }

  const ageHours = Math.round((now - Date.parse(expired.createdAt)) / 3_600_000);
  // eslint-disable-next-line no-console
  console.error(`[handoff-expiry] expired stale handoff for task ${taskId} (age: ${ageHours}h)`);
  void operatorNotify(buildExpiryNotice(expired, ageHours), expiryNoticeRoute(expired.route))
    .catch(() => undefined);
  return true;
}

/**
 * Expire every pending handoff past its TTL. Per-record failures are logged
 * and skipped so one bad record cannot block the rest.
 *
 * @returns the number of handoffs this call expired.
 */
export async function expireStaleHandoffs(opts: ExpireHandoffOpts = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
  const pending = await listPendingHandoffs(opts.handoffsDir);
  let count = 0;
  for (const record of pending) {
    if (!isHandoffStale(record, now, ttlMs)) continue;
    try {
      if (await expireHandoff(record.taskId, { ...opts, now, ttlMs })) count += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[handoff-expiry] failed to expire task ${record.taskId}: ${errorMessage(err)}`);
    }
  }
  return count;
}

// Invariant: module-scope throttle state for the periodic sweep. The daemon
// runs one scheduler per process, and this is the only declaration of it.
let lastSweepAt = 0;
let sweepInFlight = false;

/**
 * Periodic, fire-and-forget expiry sweep, called from the handoff maintenance
 * tick (handoff-maintenance.ts) in every daemon trigger mode.
 * Runs at most once per `EXPIRY_SWEEP_INTERVAL_MS` and never overlaps itself.
 */
export function sweepExpiredHandoffs(
  queueDir: string,
  now: number = Date.now(),
  handoffsDir?: string,
  isInFlight?: (taskId: string) => boolean,
): void {
  if (sweepInFlight || now - lastSweepAt < EXPIRY_SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  sweepInFlight = true;
  const expireOpts: Parameters<typeof expireStaleHandoffs>[0] = {
    queueDir,
    now,
    ...(handoffsDir !== undefined && { handoffsDir }),
    ...(isInFlight !== undefined && { isInFlight }),
  };
  void expireStaleHandoffs(expireOpts)
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[daemon] handoff-expiry: sweep failed: ${errorMessage(err)}`);
    })
    .finally(() => {
      sweepInFlight = false;
    });
}

/** @internal Reset the sweep throttle between tests. */
export function resetExpirySweepThrottleForTests(): void {
  lastSweepAt = 0;
  sweepInFlight = false;
}

/**
 * Push options for the expiry notice. The notice goes where the question went
 * (#1416) only when the record's `route` is a well-formed object whose
 * `chatId` is a finite number AND that chat is still in the inbound allowlist
 * (`pushIfConfigured` does not re-validate explicit targets). Anything else (a
 * missing, null, or malformed route, or a chat removed from the allowlist)
 * falls back to default routing, so the notice is never lost or misdirected.
 */
export function expiryNoticeRoute(route: unknown): { target: number; messageThreadId?: number } | undefined {
  if (route === null || typeof route !== 'object') return undefined;
  const { chatId, threadId } = route as Record<string, unknown>;
  if (typeof chatId !== 'number' || !Number.isFinite(chatId)) return undefined;
  if (!isChatAllowed(chatId, parseAllowedChatIds(env.AFK_TELEGRAM_ALLOWED_CHAT_IDS))) return undefined;
  return {
    target: chatId,
    ...(typeof threadId === 'number' && Number.isFinite(threadId) ? { messageThreadId: threadId } : {}),
  };
}

function buildExpiryNotice(record: HandoffRecord, ageHours: number): string {
  const q: unknown = record.question;
  const message = q !== null && typeof q === 'object' ? (q as Record<string, unknown>)['message'] : undefined;
  const raw = typeof message === 'string' ? message : '(question details unavailable)';
  const question = raw.length <= MAX_NOTICE_CHARS ? raw : `${raw.slice(0, MAX_NOTICE_CHARS)}…(truncated)`;
  return [
    '⌛ Daemon question expired unanswered',
    `📋 Task: ${record.taskId}`,
    question,
    `No answer after ${ageHours}h, so the task will not resume with an answer. Re-run it if it is still needed.`,
  ].join('\n');
}
