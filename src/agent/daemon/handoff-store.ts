/**
 * File-based store for durable human-handoff records.
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
 * Contract: this module is purely additive in PR 1. Nothing in the existing
 * system calls into it yet; wiring happens in PR 2.
 *
 * @module agent/daemon/handoff-store
 */

import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSafeJobId, getHandoffsDir } from '../../paths.js';

// ---------------------------------------------------------------------------
// HandoffRecord schema
// ---------------------------------------------------------------------------

/**
 * Discriminator for which elicitation handler owns a HandoffRecord.
 * - 'ask_question'  — agent-originated ask_question tool call
 * - 'mcp'           — MCP server elicitation (form / url mode)
 * - 'path_approval' — filesystem path approval gate
 */
export type HandoffRequestType = 'ask_question' | 'mcp' | 'path_approval';

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
 * won === false — another caller already claimed it (first-writer-wins CAS).
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
 * writeHandoff call for the same taskId overwrites the prior record atomically
 * (rename wins; the old pending question is replaced).
 */
export interface HandoffRecord {
  /** Daemon task ID that owns this handoff, e.g. `q-<timestamp>-<hex>`. */
  taskId: string;
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
  /** The daemon task command, preserved for re-enqueue with injected answer. */
  originalCommand: string;
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

/** Derive the per-task lock file path (used by CAS in updateHandoffAnswer). */
function lockPath(dir: string, taskId: string): string {
  return join(dir, `${taskId}.lock`);
}

/** Atomically write JSON to dest via a tmp file in the same directory (owner-only: 0o600). */
async function atomicWriteJson(dest: string, data: unknown): Promise<void> {
  const dir = join(dest, '..');
  const tmp = join(dir, `.tmp-${randomBytes(4).toString('hex')}.json`);
  try {
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, dest);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a HandoffRecord atomically to `<handoffsDir>/<taskId>.json`.
 *
 * Creates the handoffs directory if it does not exist.
 * An existing record for the same taskId is replaced atomically (the rename
 * is the single-winner gate — concurrent writers for the same taskId produce
 * one winner and one ENOENT on the loser's rename, which is re-raised).
 *
 * @param record     - The HandoffRecord to persist.
 * @param handoffsDir - Override the handoffs directory (defaults to `getHandoffsDir()`).
 */
export async function writeHandoff(
  record: HandoffRecord,
  handoffsDir: string = getHandoffsDir(),
): Promise<void> {
  assertSafeJobId(record.taskId);
  await ensureHandoffsDir(handoffsDir);
  await atomicWriteJson(handoffPath(handoffsDir, record.taskId), record);
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
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

/**
 * Record a human answer for the given taskId using an exclusive-create lock
 * file as a compare-and-swap gate to prevent TOCTOU races.
 *
 * Protocol:
 *   1. Try to create `<taskId>.lock` with O_EXCL — fails with EEXIST if
 *      another caller already holds it.
 *   2. EEXIST → return { won: false } (not an error; first-writer-wins).
 *   3. On lock acquisition, re-read the record and verify status is still
 *      'pending'; if not, return { won: false }.
 *   4. Write the updated record atomically, then release the lock.
 *   5. Return { won: true } on success.
 *
 * @param taskId      - The daemon task ID to update.
 * @param answer      - The human's response value.
 * @param source      - Which surface provided the answer ('telegram' | 'web' | 'repl').
 * @param handoffsDir - Override the handoffs directory (defaults to `getHandoffsDir()`).
 * @throws If no record exists for the taskId.
 * @returns UpdateHandoffResult — won: true if this caller claimed the record.
 */
// Invariant: a lock file older than this threshold is assumed to be a crash
// leftover (SIGKILL/OOM between lock creation and the finally-unlink). We retry
// once after unlinking; a second EEXIST means a genuine concurrent holder.
const STALE_LOCK_TTL_MS = 30_000;

export async function updateHandoffAnswer(
  taskId: string,
  answer: unknown,
  source: string,
  handoffsDir: string = getHandoffsDir(),
): Promise<UpdateHandoffResult> {
  assertSafeJobId(taskId);
  await ensureHandoffsDir(handoffsDir);
  const lock = lockPath(handoffsDir, taskId);

  // Step 1: acquire exclusive lock via O_EXCL create.
  try {
    await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Check whether the lock is stale (crash-leftover). A fresh lock means a
      // genuine concurrent holder — give up immediately.
      let lockMtime: number;
      try {
        const lockStat = await stat(lock);
        lockMtime = lockStat.mtimeMs;
      } catch {
        // Lock disappeared between our failed write and the stat — another
        // process cleaned it up. Return { won: false }; caller can retry.
        return { won: false };
      }
      if (Date.now() - lockMtime <= STALE_LOCK_TTL_MS) {
        // Lock is fresh — genuine concurrent holder; do not steal it.
        return { won: false };
      }
      // Lock is older than TTL — stale crash leftover. Unlink and retry once.
      try { await unlink(lock); } catch { /* ignore — may have been cleaned concurrently */ }
      try {
        await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
      } catch (retryErr) {
        if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
          // Genuine race on the retry — another process won.
          return { won: false };
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  // Lock acquired — release in finally regardless of outcome.
  try {
    // Step 2: re-read record inside lock.
    const existing = await readHandoff(taskId, handoffsDir);
    if (existing === null) {
      throw new Error(`handoff-store: no record found for taskId ${taskId}`);
    }

    // Step 3: guard — another winner may have landed between our EEXIST check
    // and this read (shouldn't happen with O_EXCL, but be defensive).
    if (existing.status !== 'pending') {
      return { won: false };
    }

    // Step 4: write updated record atomically.
    const updated: HandoffRecord = {
      ...existing,
      status: 'answered',
      answer,
      answeredAt: new Date().toISOString(),
      answerSource: source,
    };
    await atomicWriteJson(handoffPath(handoffsDir, taskId), updated);
    return { won: true };
  } finally {
    try { await unlink(lock); } catch { /* ignore — lock cleanup is best-effort */ }
  }
}
