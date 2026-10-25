/**
 * Bounded retention for `$AFK_STATE_DIR/file-checkpoints/` (#4271).
 *
 * Checkpointing is on by default in the REPL, so the tree needs a bound. The
 * policy mirrors the witness sweep (`agent/witness-sweep.ts`): the unit is the
 * WHOLE session directory (a partial checkpoint set would make a rewind
 * silently incomplete), evicted first by age, then oldest-first by bytes.
 *
 * Invariant: three things protect a session that may still rewind.
 *   1. The active session is excluded by identity (`activeSessionId`).
 *   2. A directory whose newest content is inside the 1-hour grace window is
 *      never evicted. Liveness is the newest mtime across the directory's
 *      contents, not the directory's own mtime (POSIX does not bump it when a
 *      file inside is appended to).
 *   3. A directory whose `.owner` or `.rewind-lock` pid is a live process is
 *      skipped, and that is re-checked immediately before removal. `.owner` is
 *      rewritten at every checkpointed turn, so another REPL that has been idle
 *      for hours (outside the grace window, and not this process's session) is
 *      still protected; a lock or owner left by a crashed process is not, so it
 *      cannot pin a directory forever. Pids recycle, which only ever errs
 *      toward keeping a directory longer.
 *
 * @module agent/file-checkpoint/retention
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '../../config/env.js';
import { getFileCheckpointsRoot, getFileCheckpointRewindLockPath, getFileCheckpointOwnerPath } from '../../paths.js';
import { newestMtimeAndBytes, type DirStats } from '../_lib/dir-newest-mtime.js';
import { isProcessAlive } from '../process-liveness.js';

export const FILE_CHECKPOINT_MAX_AGE_DAYS_DEFAULT = 14;
export const FILE_CHECKPOINT_MAX_BYTES_DEFAULT = 1024 * 1024 * 1024; // 1 GiB
export const FILE_CHECKPOINT_GRACE_MS = 60 * 60 * 1000; // 1 hour
export const FILE_CHECKPOINT_SWEEP_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Same deferral as the witness sweep: never compete with session start-up I/O. */
export const FILE_CHECKPOINT_SWEEP_START_DELAY_MS = 5000;
const STAMP_FILE = '.last-sweep';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Record this process as the live owner of a session's checkpoints. Best-effort. */
export function markCheckpointOwner(sessionId: string, stateDir?: string): void {
  const path = getFileCheckpointOwnerPath(sessionId, stateDir);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
  } catch { /* liveness marker only */ }
}

/** Mark a session as mid-restore. Returns the release function. Best-effort. */
export function acquireRewindLock(sessionId: string, stateDir?: string): () => void {
  const path = getFileCheckpointRewindLockPath(sessionId, stateDir);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
  } catch { /* lock is a guard against the sweep, not a correctness requirement */ }
  return () => {
    try { rmSync(path, { force: true }); } catch { /* next sweep sees a stale lock past grace */ }
  };
}

export interface FileCheckpointSweepOptions {
  /** Root to sweep. Defaults to `getFileCheckpointsRoot()`. */
  root?: string;
  /** Session running the sweep; excluded by identity. */
  activeSessionId?: string | undefined;
  maxAgeDays?: number;
  maxBytes?: number;
  /** Bypass the inter-sweep stamp. Tests and explicit operator runs only. */
  force?: boolean;
  /** Clock override for tests. */
  now?: number;
}

export interface FileCheckpointSweepResult {
  skipped: boolean;
  scanned: number;
  evicted: string[];
  freedBytes: number;
}

type Measured = { name: string; path: string } & DirStats;

function positive(raw: number | string | undefined, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True when `file` names a pid that is still running. Missing/unparseable = false. */
function livePid(file: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
  } catch {
    return false;
  }
}

/** A live process owns or is restoring this session directory. */
function inUse(dir: string): boolean {
  return livePid(join(dir, '.rewind-lock')) || livePid(join(dir, '.owner'));
}

/** Pick evictions: everything past the age bound, then oldest-first until under the byte cap. */
export function chooseEvictions(
  dirs: readonly Measured[], now: number, maxAgeMs: number, maxBytes: number,
): Measured[] {
  const oldestFirst = [...dirs].sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);
  let remaining = oldestFirst.reduce((sum, d) => sum + d.bytes, 0);
  const chosen: Measured[] = [];
  for (const dir of oldestFirst) {
    const age = now - dir.newestMtimeMs;
    if (age < FILE_CHECKPOINT_GRACE_MS || inUse(dir.path)) continue;
    if (age > maxAgeMs || remaining > maxBytes) {
      chosen.push(dir);
      remaining -= dir.bytes;
    }
  }
  return chosen;
}

async function measure(root: string, activeSessionId: string | undefined): Promise<Measured[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const measured: Measured[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === activeSessionId) continue;
    const path = join(root, entry.name);
    try { measured.push({ name: entry.name, path, ...(await newestMtimeAndBytes(path)) }); }
    catch { /* unreadable: leave it alone */ }
  }
  return measured;
}

/**
 * Sweep the checkpoint tree. Contract: best-effort and never throws; a missing
 * root or permission error resolves to an empty result.
 */
export async function sweepFileCheckpoints(
  options: FileCheckpointSweepOptions = {},
): Promise<FileCheckpointSweepResult> {
  const result: FileCheckpointSweepResult = { skipped: true, scanned: 0, evicted: [], freedBytes: 0 };
  if (env.AFK_FILE_CHECKPOINT_RETENTION_DISABLE === '1') return result;
  const root = options.root ?? getFileCheckpointsRoot();
  const now = options.now ?? Date.now();
  try {
    if (options.force !== true) {
      const last = await stat(join(root, STAMP_FILE)).then((s) => s.mtimeMs, () => undefined);
      if (last !== undefined && now - last < FILE_CHECKPOINT_SWEEP_MIN_INTERVAL_MS) return result;
    }
    const maxAgeMs = positive(options.maxAgeDays ?? env.AFK_FILE_CHECKPOINT_MAX_AGE_DAYS, FILE_CHECKPOINT_MAX_AGE_DAYS_DEFAULT) * DAY_MS;
    const maxBytes = positive(options.maxBytes ?? env.AFK_FILE_CHECKPOINT_MAX_BYTES, FILE_CHECKPOINT_MAX_BYTES_DEFAULT);
    const measured = await measure(root, options.activeSessionId);
    result.skipped = false;
    result.scanned = measured.length;
    for (const dir of chooseEvictions(measured, now, maxAgeMs, maxBytes)) {
      // Invariant: re-check liveness immediately before removal (see module doc).
      if (inUse(dir.path)) continue;
      try {
        await rm(dir.path, { recursive: true, force: true });
        result.evicted.push(dir.name);
        result.freedBytes += dir.bytes;
      } catch { /* leave it for the next sweep */ }
    }
    await writeFile(join(root, STAMP_FILE), `${new Date(now).toISOString()}\n`, { mode: 0o600 }).catch(() => undefined);
  } catch { /* missing root or permission error: not fatal */ }
  return result;
}
