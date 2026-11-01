/**
 * PauseController — singleton that blocks async checkpoints when a
 * `pause.lock` file is present in the AFK state directory.
 *
 * Three integration points call `await PauseController.instance().check()`:
 *   1. `abortable-stream.ts`   — before each SSE yield
 *   2. `dispatcher.ts`         — before each tool execute()
 *   3. `loop-iteration.ts`     — before each runOneTurn()
 *
 * The lock file is watched via BOTH `fs.watch` (fast path) AND a 250 ms
 * `setInterval` poll (reliable fallback for network/container file systems
 * where inotify is unavailable).
 *
 * Lock file format: `{ pid: number, timestamp: string }` — the PID lets
 * `check()` auto-clean a stale lock whose writer process is no longer alive.
 *
 * @module agent/session/pause-controller
 */

import { existsSync, watchFile, unwatchFile, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getAfkStateDir } from '../../paths.js';

// ---------------------------------------------------------------------------
// Lock file path — exported so CLI commands can use it without re-joining
// ---------------------------------------------------------------------------

export function getPauseLockPath(): string {
  return join(getAfkStateDir(), 'pause.lock');
}

// ---------------------------------------------------------------------------
// Lock file schema
// ---------------------------------------------------------------------------

interface PauseLockData {
  pid: number;
  timestamp: string;
}

/** Milliseconds after which a lock from a dead PID is considered stale. */
const STALE_LOCK_AGE_MS = 30_000;

function parseLock(path: string): PauseLockData | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PauseLockData;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLockStale(lock: PauseLockData): boolean {
  if (isProcessAlive(lock.pid)) return false;
  const age = Date.now() - new Date(lock.timestamp).getTime();
  return age > STALE_LOCK_AGE_MS;
}

// ---------------------------------------------------------------------------
// PauseController
// ---------------------------------------------------------------------------

export class PauseController {
  private static _instance: PauseController | undefined;

  /** Lazy singleton. */
  static instance(): PauseController {
    PauseController._instance ??= new PauseController();
    return PauseController._instance;
  }

  /** Reset the singleton — for use in tests only. */
  static _resetForTest(): void {
    PauseController._instance?.dispose();
    PauseController._instance = undefined;
  }

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  private _paused = false;
  private _pollInterval: ReturnType<typeof setInterval> | null = null;
  private _watchPath: string;

  // -------------------------------------------------------------------------
  // Constructor / dispose
  // -------------------------------------------------------------------------

  private constructor() {
    this._watchPath = getPauseLockPath();
    this._startWatching();
  }

  dispose(): void {
    if (this._pollInterval !== null) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    try { unwatchFile(this._watchPath); } catch { /* best-effort */ }
    // Drain listeners so blocked check() callers unblock and resolve.
    this._paused = false;
    for (const fn of resumeListeners) fn();
    resumeListeners.clear();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Synchronous paused-state check. */
  isPaused(): boolean {
    return this._paused;
  }

  /**
   * Await this at every checkpoint. Returns immediately when not paused.
   * Blocks (returns a pending Promise) when paused. Rejects when `signal`
   * fires so SIGTERM can override a paused session.
   */
  async check(signal?: AbortSignal): Promise<void> {
    // Fast path: not paused.
    if (!this._paused) return;

    // Check for stale lock before blocking.
    const lock = parseLock(this._watchPath);
    if (lock === null || isLockStale(lock)) {
      this._handleResume();
      return;
    }

    if (signal?.aborted) throw abortError(signal);

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(abortError(signal!));
      };
      const onResume = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resumeListeners.delete(onResume);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      resumeListeners.add(onResume);
    });
  }

  // -------------------------------------------------------------------------
  // Internal — pause / resume transitions
  // -------------------------------------------------------------------------

  private _handlePause(): void {
    if (this._paused) return;
    this._paused = true;
    // _resumeResolve is populated lazily in check() via the resumeListeners set;
    // nothing to arm here — callers register themselves when they call check().
  }

  private _handleResume(): void {
    if (!this._paused) return;
    this._paused = false;
    // Drain the listener set so all pending check() callers unblock.
    for (const fn of resumeListeners) fn();
    resumeListeners.clear();
  }

  private _syncState(): void {
    const exists = existsSync(this._watchPath);
    if (exists) {
      const lock = parseLock(this._watchPath);
      if (lock !== null && !isLockStale(lock)) {
        this._handlePause();
        return;
      }
      // Stale lock — auto-clean and treat as resumed.
      try { unlinkSync(this._watchPath); } catch { /* best-effort */ }
    }
    this._handleResume();
  }

  private _startWatching(): void {
    // Fast path: fs.watch (inotify / kqueue). Best-effort — not all file
    // systems support it; the poll interval is the reliable fallback.
    try {
      watchFile(this._watchPath, { persistent: false, interval: 250 }, () => {
        this._syncState();
      });
    } catch { /* best-effort */ }

    // Reliable fallback: poll every 250 ms.
    this._pollInterval = setInterval(() => { this._syncState(); }, 250);
    // Don't keep the process alive just for polling.
    this._pollInterval.unref?.();

    // Sync immediately in case the lock file already exists.
    this._syncState();
  }
}

// ---------------------------------------------------------------------------
// Module-level resume listener set (shared across check() callers)
// ---------------------------------------------------------------------------

const resumeListeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(
    typeof reason === 'string' && reason.length > 0 ? reason : 'Paused check aborted',
  );
  err.name = 'AbortError';
  return err;
}

// ---------------------------------------------------------------------------
// Lock file writer/remover — used by CLI commands
// ---------------------------------------------------------------------------

export function writePauseLock(): void {
  const path = getPauseLockPath();
  try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
  const data: PauseLockData = { pid: process.pid, timestamp: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(data), 'utf8');
}

export function removePauseLock(): void {
  try { unlinkSync(getPauseLockPath()); } catch { /* already gone */ }
}
