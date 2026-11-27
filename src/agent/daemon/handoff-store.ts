/**
 * Contract: file-based store for durable human-handoff records.
 *
 * A HandoffRecord is written when the daemon's elicitation router needs to
 * ask a human a question via Telegram. Writing the record BEFORE sending the
 * Telegram message ensures that a daemon restart can re-present the question
 * rather than losing it silently (crash between write+send is benign;
 * crash between send+write is unrecoverable).
 *
 * Directory layout: `<handoffsDir>/<taskId>.json`
 * Each task has at most one pending handoff at a time.
 *
 * Writes are atomic: payload is written to a temp file in the same directory
 * then renamed into place — same pattern as queue-store.ts and lease-store.ts.
 *
 * Replacements, answers, expiry and delivery metadata updates share one
 * per-task lock. Only replacement assigns a new question identity.
 *
 * @module agent/daemon/handoff-store
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertSafeJobId, getHandoffsDir } from '../../paths.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import { isErrnoCode, isWindowsLockContention } from '../../utils/errors.js';
import { debugLog } from '../../utils/debug.js';

// ---------------------------------------------------------------------------
// HandoffRecord schema
// ---------------------------------------------------------------------------

/**
 * Discriminator for which elicitation handler owns a HandoffRecord.
 * - 'ask_question'  — agent-originated ask_question tool call
 * - 'mcp'           — MCP server elicitation (form / url mode)
 * - 'path_approval' — filesystem path approval gate
 */
type HandoffRequestType = 'ask_question' | 'mcp' | 'path_approval';

/**
 * Telegram route information needed to re-present the question after a
 * daemon restart.
 */
export interface HandoffRoute {
  /** Telegram chat id where the question was (or will be) sent. */
  chatId: number;
  /** Optional topic thread id for supergroups with topics enabled. */
  threadId?: number;
}

/**
 * Result returned by updateHandoffAnswer.
 * won === true  — this caller claimed the record and wrote the answer.
 * won === false — the caller could not claim a pending record in scope.
 */
export interface UpdateHandoffResult {
  won: boolean;
}

/**
 * Durable record for a daemon task waiting on a human answer.
 *
 * Lifecycle: pending → answered | expired | cancelled
 *
 * Invariant: at most one HandoffRecord per taskId exists on disk. A second
 * writeHandoff call for the same taskId replaces the prior record atomically
 * under the task lock, with a new questionId.
 */
export interface HandoffRecord {
  /** Daemon task ID that owns this handoff, e.g. `q-<timestamp>-<hex>`. */
  taskId: string;
  /** Identity of this specific question; absent on legacy records. */
  questionId?: string;
  /** SDK session ID of the session that raised the elicitation. */
  sessionId: string;
  /**
   * Complete serializable elicitation request, stored verbatim so recovery
   * can re-present the exact question without access to the original session.
   * Use `requestType` to determine which handler owns this record.
   */
  question: Record<string, unknown>;
  /**
   * Discriminator: which elicitation handler to invoke during recovery.
   * 'ask_question' | 'mcp' | 'path_approval'
   */
  requestType: HandoffRequestType;
  /** Telegram route for re-presentation after restart. Optional in REPL context. */
  route?: HandoffRoute;
  /**
   * Opaque elicitation ID used by the Telegram handler for button routing.
   * Present when the originating surface set one (choice/confirm elicitations).
   */
  elicitId?: string;
  /** ISO 8601 timestamp when this record was created. */
  createdAt: string;
  /** Current lifecycle status. */
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  /** The human's response, set when status transitions to 'answered'. */
  answer?: unknown;
  /** ISO 8601 timestamp when the answer was recorded. */
  answeredAt?: string;
  /** Which surface recorded the answer ('telegram' | 'web' | 'repl'). */
  answerSource?: string;
  /** ISO 8601 timestamp when the record transitioned to 'expired' (handoff-expiry.ts). */
  expiredAt?: string;
  /**
   * Contract: opaque identity of the responder for provenance tracking.
   *
   * Format is surface-specific:
   *   - Telegram: `"<userId>"` (numeric string) or `"<userId>:<username>"` when
   *     a username is available (e.g. `"123456789:alice"`).
   *   - Web: `"web:<remoteIp>"` when the server captures the remote address.
   *   - REPL: `"repl"` (single interactive operator, no meaningful identity).
   *
   * Intentionally opaque to the store layer — callers supply whatever
   * identity token their surface exposes; the consumer (audit log, PR 3)
   * parses it with surface-specific logic.
   *
   * **PII note**: Telegram userId and username are personal data. This field
   * is written to a 0o600 file under `getHandoffsDir()`. Records are deleted
   * by `deleteHandoff` / `cleanupHandoff` once the answer has been consumed.
   * Callers that retain records for audit purposes are responsible for their
   * own retention and deletion policy.
   */
  responderIdentity?: string;
  /** The daemon task command, preserved for re-enqueue with injected answer. */
  originalCommand: string;
  /**
   * Telegram message_id of the question message sent to the operator.
   * Used by the reply-to-message matching path: when the operator replies
   * to this message, the bot matches the reply's `reply_to_message.message_id`
   * against this field to route the answer to the correct handoff.
   * Populated after the Telegram message is successfully sent.
   */
  telegramMessageId?: number;
  /**
   * Origin context of the task that asked (#1416), carried into the resumed
   * run: original task id (overlap identity), pinned cwd, and notification
   * policy. Optional; absent on records written before these fields existed.
   * See handoff-resume-context.ts.
   */
  originalTaskId?: string;
  cwd?: string;
  notifyOn?: 'failure' | 'always' | 'never';
  notifyChat?: number | string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure the handoffs directory exists before writing (owner-only: 0o700). */
async function ensureHandoffsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Derive the per-task file path from the handoffs directory and taskId. */
function handoffPath(dir: string, taskId: string): string {
  return join(dir, `${taskId}.json`);
}

/** Derive the per-task lock file path shared by replacement and pending updates. */
function lockPath(dir: string, taskId: string): string {
  return join(dir, `${taskId}.lock`);
}

/** Atomically write JSON to dest via a tmp file in the same directory (owner-only: 0o600). */
async function atomicWriteJson(dest: string, data: unknown): Promise<void> {
  await atomicWriteFileAsync(dest, JSON.stringify(data), { mode: 0o600, mkdirp: false });
}

// Parallel replacements should each get a turn, but writes must not block
// indefinitely on a busy lock. The retry budget is below the stale-lock TTL.
const REPLACEMENT_LOCK_RETRIES = 100;
const REPLACEMENT_LOCK_RETRY_MS = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a HandoffRecord atomically to `<handoffsDir>/<taskId>.json`.
 *
 * Creates the handoffs directory if it does not exist.
 * Assigns a new questionId, replacing any existing record for the same taskId.
 * Retries on lock contention so parallel replacements can succeed in sequence;
 * throws if the lock stays busy through the retry budget.
 *
 * @param record     - The HandoffRecord to persist.
 * @param handoffsDir - Override the handoffs directory (defaults to `getHandoffsDir()`).
 */
export async function writeHandoff(
  record: HandoffRecord,
  handoffsDir: string = getHandoffsDir(),
): Promise<HandoffRecord & { questionId: string }> {
  assertSafeJobId(record.taskId);
  await ensureHandoffsDir(handoffsDir);
  const persisted = { ...record, questionId: randomUUID() };
  for (let attempt = 0; ; attempt++) {
    const result = await withHandoffLock(persisted.taskId, handoffsDir, async () => {
      await atomicWriteJson(handoffPath(handoffsDir, persisted.taskId), persisted);
      return persisted;
    });
    if (result !== null) return result;
    if (attempt === REPLACEMENT_LOCK_RETRIES) {
      throw new Error(`handoff-store: timed out waiting to replace handoff for taskId ${persisted.taskId}`);
    }
    await sleep(REPLACEMENT_LOCK_RETRY_MS);
  }
}

/**
 * Read the HandoffRecord for the given taskId from disk.
 *
 * @param taskId      - The daemon task ID to look up.
 * @param handoffsDir - Override the handoffs directory (defaults to `getHandoffsDir()`).
 * @returns The HandoffRecord, or `null` if no file exists for the given taskId.
 */
export async function readHandoff(
  taskId: string,
  handoffsDir: string = getHandoffsDir(),
): Promise<HandoffRecord | null> {
  assertSafeJobId(taskId);
  const filePath = handoffPath(handoffsDir, taskId);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as HandoffRecord;
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return null;
    throw err;
  }
}

/**
 * Remove the HandoffRecord file for the given taskId.
 *
 * Idempotent: does not throw if the file is already absent.
 *
 * @param taskId      - The daemon task ID whose record to remove.
 * @param handoffsDir - Override the handoffs directory (defaults to `getHandoffsDir()`).
 */
export async function deleteHandoff(
  taskId: string,
  handoffsDir: string = getHandoffsDir(),
): Promise<void> {
  assertSafeJobId(taskId);
  try {
    await rm(handoffPath(handoffsDir, taskId), { force: true });
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return;
    throw err;
  }
}

/**
 * List all HandoffRecords with status === 'pending'.
 *
 * Skips temp files (`.tmp-*.json`), lock files (`.lock`), unreadable files,
 * and records whose JSON cannot be parsed — so one corrupt file does not abort
 * the whole listing. Each skip is a silent no-op; callers should not assume
 * the list is complete if the directory may contain corrupt entries.
 *
 * @param handoffsDir - Override the handoffs directory (defaults to `getHandoffsDir()`).
 * @returns Array of HandoffRecord items in status 'pending'.
 */
export async function listPendingHandoffs(
  handoffsDir: string = getHandoffsDir(),
): Promise<HandoffRecord[]> {
  try {
    await ensureHandoffsDir(handoffsDir);
  } catch {
    return [];
  }

  let filenames: string[];
  try {
    filenames = await readdir(handoffsDir);
  } catch {
    return [];
  }

  const pending: HandoffRecord[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith('.json') || filename.startsWith('.tmp-')) continue;
    try {
      const raw = await readFile(join(handoffsDir, filename), 'utf-8');
      const record = JSON.parse(raw) as HandoffRecord;
      if (record.status === 'pending') pending.push(record);
    } catch {
      // Silently skip unreadable or malformed records.
    }
  }
  return pending;
}

// Invariant: a lock older than this threshold is assumed to be a crash leftover.
const STALE_LOCK_TTL_MS = 30_000;

/**
 * Contract: acquire the O_EXCL lock for a taskId, run `cb` inside the lock, then release.
 *
 * Protocol:
 *   1. Try to create `<taskId>.lock` with O_EXCL — fails immediately with EEXIST
 *      if another caller already holds it (returns null without running cb).
 *   2. On EEXIST, check whether the lock file is older than STALE_LOCK_TTL_MS.
 *      If stale (crash leftover), unlink and retry once. A second EEXIST means a
 *      genuine concurrent holder — return null.
 *   3. Run `cb()` with the lock held.
 *   4. Release the lock in a finally block regardless of cb outcome.
 *
 * Returns the value returned by `cb`, or `null` when the lock could not be acquired.
 *
 * @param taskId      - The daemon task ID whose lock to acquire.
 * @param handoffsDir - Directory containing the lock file.
 * @param cb          - Callback to run while the lock is held.
 */
export async function withHandoffLock<T>(
  taskId: string,
  handoffsDir: string,
  cb: () => Promise<T>,
  /** Injectable for unit-testing on any OS; defaults to `process.platform`. */
  platform: string = process.platform,
): Promise<T | null> {
  const lock = lockPath(handoffsDir, taskId);

  // Step 1: acquire exclusive lock via O_EXCL create.
  try {
    await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // On Windows, a just-released lock sits in "delete-pending" state until
    // the last handle closes. An O_EXCL create during that window gets
    // EPERM/EACCES/EBUSY. Treat those as contention — same as EEXIST.
    if (isErrnoCode(err, 'EEXIST') || isWindowsLockContention(err, platform)) {
      // Check whether the lock is stale (crash-leftover). A fresh lock means a
      // genuine concurrent holder — give up immediately.
      let lockMtime: number;
      try {
        const lockStat = await stat(lock);
        lockMtime = lockStat.mtimeMs;
      } catch {
        // Lock disappeared between our failed write and the stat — another
        // process cleaned it up. Caller can retry.
        return null;
      }
      if (Date.now() - lockMtime <= STALE_LOCK_TTL_MS) {
        // Lock is fresh — genuine concurrent holder; do not steal it.
        return null;
      }
      // Lock is older than TTL — stale crash leftover. Unlink and retry once.
      try { await unlink(lock); } catch { /* ignore — may have been cleaned concurrently */ }
      try {
        await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
      } catch (retryErr) {
        if (isErrnoCode(retryErr, 'EEXIST') || isWindowsLockContention(retryErr, platform)) {
          // Genuine race on the retry — another process won.
          return null;
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  // Lock acquired — release in finally regardless of outcome.
  try {
    return await cb();
  } finally {
    try { await unlink(lock); } catch { /* ignore — lock cleanup is best-effort */ }
  }
}

/**
 * Options for `updateHandoffAnswer`.
 */
export interface UpdateHandoffAnswerOpts {
  /** Override the handoffs directory (defaults to `getHandoffsDir()`). */
  handoffsDir?: string;
  /**
   * Optional opaque identity token for the responder (surface-specific).
   * See `HandoffRecord.responderIdentity` for format details and PII note.
   */
  responderIdentity?: string;
  /** Omit or pass undefined for an unscoped answer; null matches only legacy records. */
  expectedQuestionId?: string | null | undefined;
}

function matchesQuestionId(record: HandoffRecord, expectedQuestionId: string | null): boolean {
  return record.questionId === (expectedQuestionId === null ? undefined : expectedQuestionId);
}

/** Prefix of the error thrown by unscoped {@link updateHandoffAnswer} when the
 *  record no longer exists. Consumers should match this constant. */
export const HANDOFF_STORE_NO_RECORD_PREFIX = 'handoff-store: no record found' as const;

/**
 * Contract: record a human answer for the given taskId using an exclusive-create lock
 * file as a compare-and-swap gate to prevent TOCTOU races.
 *
 * Protocol:
 *   1. Acquire the O_EXCL lock via withHandoffLock — returns { won: false } if
 *      another caller already holds it (first-writer-wins CAS).
 *   2. Re-read the record and verify status is still 'pending' and any expected
 *      question identity matches; if not, return { won: false }.
 *   3. Write the updated record atomically, then release the lock.
 *   4. Return { won: true } on success.
 *
 * @param taskId  - The daemon task ID to update.
 * @param answer  - The human's response value.
 * @param source  - Which surface provided the answer ('telegram' | 'web' | 'repl').
 * @param opts    - Optional directory, responder identity and question identity.
 * @throws If the record is missing and the answer is unscoped.
 * @returns UpdateHandoffResult — won: true if this caller claimed the record.
 */
export async function updateHandoffAnswer(
  taskId: string,
  answer: unknown,
  source: string,
  opts: UpdateHandoffAnswerOpts = {},
): Promise<UpdateHandoffResult> {
  const { handoffsDir = getHandoffsDir(), responderIdentity, expectedQuestionId } = opts;
  assertSafeJobId(taskId);
  await ensureHandoffsDir(handoffsDir);

  const result = await withHandoffLock(taskId, handoffsDir, async () => {
    // Re-read record inside lock.
    const existing = await readHandoff(taskId, handoffsDir);
    if (existing === null) {
      if (expectedQuestionId !== undefined) return { won: false };
      throw new Error(`${HANDOFF_STORE_NO_RECORD_PREFIX} for taskId ${taskId}`);
    }
    if (existing.status !== 'pending' || (
      expectedQuestionId !== undefined && !matchesQuestionId(existing, expectedQuestionId)
    )) {
      return { won: false };
    }

    // Write updated record atomically.
    const updated: HandoffRecord = {
      ...existing,
      status: 'answered',
      answer,
      answeredAt: new Date().toISOString(),
      answerSource: source,
      ...(responderIdentity !== undefined ? { responderIdentity } : {}),
    };
    await atomicWriteJson(handoffPath(handoffsDir, taskId), updated);

    if (responderIdentity !== undefined) {
      debugLog(`[handoff-store] responderIdentity captured for task ${taskId} (present, masked)`);
    } else {
      debugLog(`[handoff-store] responderIdentity absent for task ${taskId} (source: ${source})`);
    }

    return { won: true };
  });

  // null means the lock was not acquired — another caller holds it.
  return result ?? { won: false };
}

/** Update delivery metadata only for the exact pending question (null = legacy). */
export async function updateHandoffMessage(
  taskId: string,
  expectedQuestionId: string | null,
  route: HandoffRoute,
  telegramMessageId: number,
  handoffsDir: string = getHandoffsDir(),
): Promise<void> {
  assertSafeJobId(taskId);
  await ensureHandoffsDir(handoffsDir);
  await withHandoffLock(taskId, handoffsDir, async () => {
    const existing = await readHandoff(taskId, handoffsDir);
    if (existing?.status !== 'pending' || !matchesQuestionId(existing, expectedQuestionId)) return;
    await atomicWriteJson(handoffPath(handoffsDir, taskId), { ...existing, route, telegramMessageId });
  });
}

/** @internal Expire under the task lock; return the previous record for lease/notice handling. */
export async function expirePendingHandoff(
  taskId: string,
  handoffsDir: string,
  now: number,
  isStale: (record: HandoffRecord) => boolean,
): Promise<HandoffRecord | null> {
  assertSafeJobId(taskId);
  await ensureHandoffsDir(handoffsDir);
  return withHandoffLock(taskId, handoffsDir, async () => {
    const existing = await readHandoff(taskId, handoffsDir);
    if (existing?.status !== 'pending' || !isStale(existing)) return null;
    await atomicWriteJson(handoffPath(handoffsDir, taskId), {
      ...existing,
      status: 'expired',
      expiredAt: new Date(now).toISOString(),
    });
    return existing;
  });
}
