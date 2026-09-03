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

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getHandoffsDir } from '../../paths.js';

// ---------------------------------------------------------------------------
// HandoffRecord schema
// ---------------------------------------------------------------------------

/**
 * Full content of an elicitation question, mirroring the ElicitationRequest
 * fields consumed by the Telegram handler. Stored verbatim so recovery can
 * re-present the exact question without access to the original session.
 */
export interface HandoffQuestion {
  /** Elicitation type: 'text' | 'confirm' | 'choice' | 'multi_choice' | 'number'. */
  type: string;
  /** Full question text — NOT truncated. */
  message: string;
  /** Enumerated options for choice / multi_choice elicitations. */
  choices?: string[];
  /** Default value pre-selected for the human. */
  default?: string | boolean | number;
  /** Whether the human may type a free-form answer alongside enumerated choices. */
  allowCustom?: boolean;
  /** Whether the human may skip the question. */
  allowSkip?: boolean;
  /** Minimum value for number elicitations. */
  min?: number;
  /** Maximum value for number elicitations. */
  max?: number;
  /** Minimum text length for text elicitations. */
  minLength?: number;
  /** Maximum text length for text elicitations. */
  maxLength?: number;
}

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
  /** Full elicitation question content for re-presentation. */
  question: HandoffQuestion;
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

/** Ensure the handoffs directory exists before writing. */
async function ensureHandoffsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Derive the per-task file path from the handoffs directory and taskId. */
function handoffPath(dir: string, taskId: string): string {
  return join(dir, `${taskId}.json`);
}

/** Atomically write JSON to dest via a tmp file in the same directory. */
async function atomicWriteJson(dest: string, data: unknown): Promise<void> {
  const dir = join(dest, '..');
  const tmp = join(dir, `.tmp-${randomBytes(4).toString('hex')}.json`);
  try {
    await writeFile(tmp, JSON.stringify(data), 'utf-8');
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
 * Skips temp files (`.tmp-*.json`), unreadable files, and records whose JSON
 * cannot be parsed — so one corrupt file does not abort the whole listing.
 * Each skip is a silent no-op; callers should not assume the list is complete
 * if the directory may contain corrupt entries.
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
 * Record a human answer for the given taskId.
 *
 * Reads the existing record, validates it is still in 'pending' status,
 * updates the status to 'answered' along with answer/answeredAt/answerSource,
 * and rewrites atomically.
 *
 * @param taskId      - The daemon task ID to update.
 * @param answer      - The human's response value.
 * @param source      - Which surface provided the answer ('telegram' | 'web' | 'repl').
 * @param handoffsDir - Override the handoffs directory (defaults to `getHandoffsDir()`).
 * @throws If no record exists for the taskId, or if the record is not in 'pending' status.
 */
export async function updateHandoffAnswer(
  taskId: string,
  answer: unknown,
  source: string,
  handoffsDir: string = getHandoffsDir(),
): Promise<void> {
  const existing = await readHandoff(taskId, handoffsDir);
  if (existing === null) {
    throw new Error(`handoff-store: no record found for taskId ${taskId}`);
  }
  if (existing.status !== 'pending') {
    throw new Error(
      `handoff-store: cannot answer taskId ${taskId} in status '${existing.status}'`,
    );
  }
  const updated: HandoffRecord = {
    ...existing,
    status: 'answered',
    answer,
    answeredAt: new Date().toISOString(),
    answerSource: source,
  };
  await atomicWriteJson(handoffPath(handoffsDir, taskId), updated);
}
