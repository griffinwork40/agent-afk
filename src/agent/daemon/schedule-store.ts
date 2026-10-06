/**
 * Persistent store for scheduled task configurations.
 *
 * Persists to `~/.afk/config/schedules.json` (default). All writes are
 * atomic (temp + rename) to avoid leaving a half-written file. Missing file
 * returns an empty array. JSON parse failures log to stderr and return [].
 *
 * Read-modify-write operations (`addSchedule`, `removeSchedule`,
 * `updateSchedule`) are guarded by an `O_EXCL` advisory lockfile so that
 * concurrent callers (parallel agents, CLI + daemon HTTP handler, or two
 * REPL sessions) cannot silently drop each other's changes.
 *
 * @module agent/daemon/schedule-store
 */

import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getSchedulesPath } from '../../paths.js';
import { expandCwd } from './cwd-validator.js';
import type { ScheduledTask, TaskExecutor } from './triggers.js';
import { errorMessage } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Advisory file lock (O_EXCL)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 15_000;

interface LockOwner {
  pid: number;
  token: string;
}

function writeLockFile(lockPath: string, owner: LockOwner): void {
  const fd = openSync(lockPath, 'wx');
  try {
    writeSync(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<LockOwner>;
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // Malformed or concurrently removed locks cannot be proven dead.
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

function sameOwner(a: LockOwner | undefined, b: LockOwner | undefined): boolean {
  return a !== undefined && b !== undefined && a.pid === b.pid && a.token === b.token;
}

// Invariant: reclamation uses hardlink (linkSync) to atomically claim ownership
// of a dead lock file — only one contender's claim can match the original inode.
// On filesystems where hardlinks are unavailable (cross-device EXDEV, permission
// EPERM), this throws and the caller falls through to the catch block, degrading
// gracefully to retry-based polling until the lock holder releases or times out.
function tryReclaimDeadLock(lockPath: string, owner: LockOwner): void {
  if (isProcessAlive(owner.pid)) return;
  const claimPath = `${lockPath}.claim.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    linkSync(lockPath, claimPath);
    const lockStat = statSync(lockPath);
    const claimStat = statSync(claimPath);
    const sameFile = lockStat.dev === claimStat.dev && lockStat.ino === claimStat.ino;
    if (sameFile && sameOwner(owner, readLockOwner(claimPath)) && !isProcessAlive(owner.pid)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Another contender may have removed or replaced the lock. Retry acquisition.
  } finally {
    try { unlinkSync(claimPath); } catch { /* best effort */ }
  }
}

// Invariant: SharedArrayBuffer + Atomics.wait is intentional here — it is the only
// way to block the current thread synchronously without a spin-loop or busy-wait.
// Available on Node >=12; safe in non-worker contexts since Node >=22 (no
// --experimental-shared-memory flag required). We need synchronous blocking
// because withFileLock must be callable from synchronous code paths.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` under an O_EXCL advisory lock on `storePath + ".lock"`.
 * Stale locks are removed only when their recorded owner process is dead.
 * Throws if the lock cannot be acquired within LOCK_TIMEOUT_MS.
 */
function withFileLock<T>(storePath: string, fn: () => T): T {
  const lp = `${storePath}.lock`;
  mkdirSync(dirname(lp), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const owner: LockOwner = { pid: process.pid, token: randomBytes(8).toString('hex') };
  let acquired = false;

  while (!acquired) {
    if (Date.now() >= deadline) throw new Error(`[schedule-store] lock timeout: ${lp}`);
    try {
      writeLockFile(lp, owner);
      acquired = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;
      const currentOwner = readLockOwner(lp);
      try {
        if (currentOwner && Date.now() - statSync(lp).mtimeMs > LOCK_STALE_MS) {
          tryReclaimDeadLock(lp, currentOwner);
        }
      } catch {
        // Removed concurrently. Retry acquisition until the deadline.
      }
      const wait = Math.min(LOCK_POLL_MS, deadline - Date.now());
      if (wait > 0) sleepSync(wait);
    }
  }

  try {
    return fn();
  } finally {
    if (sameOwner(owner, readLockOwner(lp))) {
      try { unlinkSync(lp); } catch { /* best effort */ }
    }
  }
}

export interface ScheduledTaskConfig {
  /** Slug ID, e.g. "nightly-forge". Auto-generated from `name` via `slugify`. */
  id: string;
  /** Human-readable label, e.g. "Nightly forge friction". */
  name: string;
  /**
   * Meaning depends on `executor`:
   * - `'agent'` (default): prompt sent as a user message (e.g. "/forge-friction --auto").
   * - `'shell'`: shell command run via `/bin/sh -c` (e.g. "pg_dump mydb > /backups/nightly.sql").
   */
  command: string;
  /** 5- or 6-field cron expression, e.g. "0 2 * * *". */
  cron: string;
  /**
   * Per-task working directory (absolute path). When set, the spawned session's
   * cwd is pinned to this directory instead of the daemon-wide `AFK_DAEMON_CWD`.
   * Precedence: task.cwd ?? AFK_DAEMON_CWD ?? daemonDefaultCwd().
   * Must be an existing directory; tilde (~) is expanded at save time.
   */
  cwd?: string;
  /**
   * Execution strategy. Default: `'agent'` (spawn an AgentSession).
   * `'shell'` runs the command as a raw shell command with no agent session.
   * Builtins are not user-creatable -- they are registered internally.
   */
  executor?: Exclude<TaskExecutor, 'builtin'>;
  /** Trigger mode. Default: 'cron'. */
  trigger?: 'cron' | 'sessionstart' | 'both';
  /** Whether the task is active. */
  enabled: boolean;
  /**
   * Controls when out-of-band notifications fire for this task.
   * 'always'  — notify on every completion
   * 'failure' — notify only when status === 'error'
   * 'never'   — never notify
   * Omitting preserves legacy behavior (callback always fires).
   */
  notifyOn?: 'failure' | 'always' | 'never';
  /**
   * Optional explicit chat target for this task's completion notification.
   * A number is a raw Telegram chat id; a string is either a numeric id or a
   * name resolved via afk.config.json `telegram.chatAliases`. Threaded through
   * to `ScheduledTask.notifyChat`; the daemon resolves + allowlist-gates it at
   * completion-push time. Omitting it preserves default routing.
   */
  notifyChat?: number | string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * Load all scheduled task configs from the store.
 * Returns [] when the file is missing or contains invalid JSON.
 *
 * Consistency model: reads are lock-free (plain readFileSync). A concurrent
 * write via `withFileLock` may be in-flight; in that case this read returns
 * either the previous or the next committed snapshot, never a partial write,
 * because `saveSchedules` writes atomically (temp + renameSync). Callers that
 * need read-modify-write consistency must go through `withFileLock`.
 */
export function loadSchedules(path?: string): ScheduledTaskConfig[] {
  const storePath = path ?? getSchedulesPath();
  if (!existsSync(storePath)) return [];
  try {
    const raw = readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as ScheduledTaskConfig[];
  } catch (err) {
    const msg = errorMessage(err);
    // eslint-disable-next-line no-console
    console.error(`[schedule-store] failed to parse ${storePath}: ${msg}`);
    return [];
  }
}

/**
 * Atomically write a schedule list to the store.
 * Creates parent directories if needed.
 */
export function saveSchedules(configs: ScheduledTaskConfig[], path?: string): void {
  const storePath = path ?? getSchedulesPath();
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = join(
    dirname(storePath),
    `.schedules.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const payload = JSON.stringify(configs, null, 2);
  try {
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, storePath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/**
 * Add a new schedule. Generates the slug ID, resolves collisions, and
 * timestamps createdAt/updatedAt. Returns the completed config.
 *
 * If `notifyOn` is omitted, defaults to `'failure'` — schedules created
 * through this entry point (user CLI + model tools) are quiet-by-default.
 * The runtime guard in `CronScheduler.fireOnTaskComplete` treats `undefined`
 * as legacy pass-through (= always notify), so we materialize the default
 * here at write time. Tasks registered through other paths (e.g. the
 * built-in `worktree-prune` task) intentionally retain legacy behavior.
 *
 * The read-modify-write is wrapped in an advisory lockfile so concurrent
 * callers cannot silently clobber each other's additions.
 */
export function addSchedule(
  config: Omit<ScheduledTaskConfig, 'id' | 'createdAt' | 'updatedAt'>,
  path?: string,
): ScheduledTaskConfig {
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedules(storePath);
    const existing = schedules.map((s) => s.id);
    const base = slugify(config.name);
    const id = resolveSlugCollision(base, existing);
    const now = new Date().toISOString();
    const newConfig: ScheduledTaskConfig = {
      ...config,
      notifyOn: config.notifyOn ?? 'failure',
      id,
      createdAt: now,
      updatedAt: now,
    };
    schedules.push(newConfig);
    saveSchedules(schedules, storePath);
    return newConfig;
  });
}

/**
 * Remove a schedule by ID. Returns true if removed, false if not found.
 *
 * The read-modify-write is wrapped in an advisory lockfile so concurrent
 * callers cannot silently clobber each other's removals.
 */
export function removeSchedule(id: string, path?: string): boolean {
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedules(storePath);
    const before = schedules.length;
    const filtered = schedules.filter((s) => s.id !== id);
    if (filtered.length === before) return false;
    saveSchedules(filtered, storePath);
    return true;
  });
}

/**
 * Get a single schedule by ID. Returns undefined if not found.
 *
 * Inherits `loadSchedules`' lock-free consistency model: the returned config
 * reflects the latest atomically committed snapshot but may be stale relative
 * to a concurrent `withFileLock` write.
 */
export function getSchedule(id: string, path?: string): ScheduledTaskConfig | undefined {
  return loadSchedules(path).find((s) => s.id === id);
}

/** Patchable fields for `updateSchedule`. Excludes `id` and `createdAt`. */
export type SchedulePatch = Partial<Omit<ScheduledTaskConfig, 'id' | 'createdAt' | 'updatedAt' | 'cwd'>> & {
  /** Set a new directory path, or pass `null`/`""` to clear the existing one. */
  cwd?: string | null;
};

/**
 * Patch one or more fields on an existing schedule. Atomically loads,
 * merges only the supplied fields, stamps `updatedAt`, and saves.
 *
 * Returns the updated config, or undefined if the ID is not found.
 *
 * This is the canonical update primitive — the agent tool handler, the
 * web-server PATCH route, and `toggleScheduleEnabled` all delegate here
 * so field-merge logic stays in one place.
 *
 * The read-modify-write is wrapped in an advisory lockfile so concurrent
 * callers cannot silently clobber each other's patches.
 */
export function updateSchedule(
  id: string,
  patch: SchedulePatch,
  path?: string,
): ScheduledTaskConfig | undefined {
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedules(storePath);
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    const existing = schedules[idx]!;
    const updated: ScheduledTaskConfig = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.executor !== undefined ? { executor: patch.executor } : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
      ...(patch.notifyOn !== undefined ? { notifyOn: patch.notifyOn } : {}),
      ...(patch.notifyChat !== undefined ? { notifyChat: patch.notifyChat } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.cwd !== undefined && patch.cwd !== null ? { cwd: patch.cwd } : {}),
      updatedAt: new Date().toISOString(),
    };
    // cwd: null means "clear" — remove the per-task pinning entirely so the task
    // falls back to the daemon-wide AFK_DAEMON_CWD default.
    if (patch.cwd === null) delete updated.cwd;
    schedules[idx] = updated;
    saveSchedules(schedules, storePath);
    return updated;
  });
}

/**
 * Toggle a schedule's enabled state. Atomically loads, updates, and saves.
 *
 * Returns the updated config, or undefined if the ID is not found.
 *
 * This is the single source of truth for enable/disable persistence — the CLI
 * commands and the cancel_schedule tool handler all delegate here so the
 * toggle logic stays in one place and no fields are silently dropped.
 */
export function toggleScheduleEnabled(
  id: string,
  enabled: boolean,
  path?: string,
): ScheduledTaskConfig | undefined {
  return updateSchedule(id, { enabled }, path);
}

/**
 * Convert a human-readable name into a URL/file-safe slug.
 * Lowercases, replaces non-alphanumeric chars with hyphens, collapses
 * consecutive hyphens, and strips leading/trailing hyphens.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Given a base slug and the set of existing IDs, return a unique slug.
 * Appends `-2`, `-3`, etc. until the slug is unique.
 */
export function resolveSlugCollision(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

/**
 * Map a `ScheduledTaskConfig` to a `ScheduledTask` (daemon trigger shape).
 *
 * Tilde in `cwd` is expanded via `expandCwd` so hand-edited schedules.json
 * entries with `"cwd": "~/my-project"` resolve to absolute paths at runtime.
 */
export function toScheduledTask(config: ScheduledTaskConfig): ScheduledTask {
  return {
    taskId: config.id,
    command: config.command,
    trigger: config.trigger ?? 'cron',
    ...(config.executor !== undefined ? { executor: config.executor } : {}),
    ...(config.cron !== undefined ? { cronExpression: config.cron } : {}),
    ...(config.notifyOn !== undefined ? { notifyOn: config.notifyOn } : {}),
    ...(config.notifyChat !== undefined ? { notifyChat: config.notifyChat } : {}),
    ...(config.cwd !== undefined ? { cwd: expandCwd(config.cwd) } : {}),
  };
}
