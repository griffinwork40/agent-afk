/**
 * Persistent store for scheduled task configurations.
 *
 * Persists to `~/.afk/config/schedules.json` (default). All writes are
 * atomic (temp + rename) to avoid leaving a half-written file. Missing file
 * returns an empty array. For read-only callers (`loadSchedules`), JSON parse
 * failures log to stderr and return []. Read-modify-write operations load
 * through the strict `loadSchedulesForWrite` instead, which throws
 * `UnreadableSchedulesError` (and writes nothing) when the file exists but is
 * not a JSON array, so a hand-edit typo can never wipe every schedule.
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
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getSchedulesPath } from '../../paths.js';
import { expandCwd } from './cwd-validator.js';
import type { ScheduledTask, TaskExecutor } from './triggers.js';
import { errorMessage, isErrnoCode } from '../../utils/errors.js';
import { sleepSync } from '../../utils/sleep-sync.js';
import { writeJsonFile } from '../../utils/json-file.js';
import { checkEntrySchemaVersions, loadSchedulesForWrite } from './schedule-store.strict-load.js';
import { isValidIsoDate } from '../../utils/iso-date.js';

export { UnreadableSchedulesError, loadSchedulesForWrite } from './schedule-store.strict-load.js';

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

/**
 * Returns true when `err` from `writeLockFile` represents lock contention
 * rather than a real permission problem.
 *
 * On Windows, unlinking a lock file leaves it in a "delete-pending" state
 * until every open handle is closed. A concurrent `openSync(path, 'wx')`
 * during that window receives EPERM, EACCES, or EBUSY — none of which are
 * the EEXIST the caller normally expects for contention. On POSIX those same
 * codes always mean a real permission problem, so we throw immediately there.
 *
 * Invariant: Windows delete-pending — the OS marks the file for deletion but
 * keeps its directory entry alive until the last handle closes. Any process
 * that tries to create a new file at that path before the handle closes gets
 * EPERM/EACCES/EBUSY. Treating these as transient contention lets the retry
 * loop wait until the delete completes rather than surfacing a misleading
 * permission error.
 *
 * @param err    - The error thrown by `writeLockFile`.
 * @param platform - `process.platform` value; injectable for unit-testing.
 * @internal
 */
export function isLockContention(err: unknown, platform: string): boolean {
  if (platform !== 'win32') return false;
  return (
    isErrnoCode(err, 'EPERM') ||
    isErrnoCode(err, 'EACCES') ||
    isErrnoCode(err, 'EBUSY')
  );
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
    return !isErrnoCode(err, 'ESRCH');
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
// Note: EPERM surfaces here for two unrelated reasons — (1) the filesystem does
// not support hardlinks (e.g. cross-device or restricted mount), and (2) Windows
// delete-pending: the old lock file is awaiting handle close before its directory
// entry is removed, so linkSync hits EPERM on the still-visible path. These are
// structurally distinct; only the delete-pending case is transient.
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
      if (!isErrnoCode(err, 'EEXIST') && !isLockContention(err, process.platform)) throw err;
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
  /**
   * Total attempts per run for agent tasks (default 1 = no retry); threaded to
   * `ScheduledTask.maxAttempts`. Only classified-transient failures retry.
   */
  maxAttempts?: number;
  /** Backoff base (ms) between retry attempts; threaded to `ScheduledTask.retryDelayMs`. */
  retryDelayMs?: number;
  /**
   * One-shot fire time (ISO 8601). When set, the task fires once at or after
   * this instant and is automatically disabled afterward. Mutually exclusive
   * with a recurring `cron` expression — use one or the other, not both.
   * The 5-field cron expression (placeholder `"0 * * * *"`) in `cron` is
   * used only as the scheduler tick cadence when `runAt` is set; the actual
   * fire condition is the `runAt` wall-clock comparison in the scheduler.
   */
  runAt?: string;
  /**
   * Hard expiry (ISO 8601). When set and the current time is past this
   * instant, the scheduler skips the task and records a
   * `status:'skipped', skipReason:'expired'` telemetry entry. The task is
   * also automatically disabled so it never fires again.
   */
  expiresAt?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * Current schema version understood by this build.
 *
 * Future AFK releases that introduce a breaking structural change to
 * schedules.json MUST bump this constant AND write a top-level
 * `"version": <N>` field into the file so older builds can refuse to load
 * rather than silently misinterpreting the data.
 *
 * Backward-compat invariant: files written by current/older releases carry no
 * top-level `version` field (bare JSON array). Those files are always accepted
 * unchanged — only a file whose explicit `version` exceeds this constant, or
 * an entry whose `_schemaVersion` exceeds this constant, is refused.
 */
export const SCHEDULES_SCHEMA_VERSION = 1;

/**
 * Thrown by `loadSchedules` when the on-disk file declares a schema version
 * that exceeds `SCHEDULES_SCHEMA_VERSION`.  Callers can catch this specifically
 * to surface an "upgrade afk" message rather than treating it as generic
 * corruption.
 */
export class SchedulesVersionError extends Error {
  readonly path: string;
  readonly fileVersion: number | undefined;

  constructor(path: string, message: string, fileVersion?: number) {
    super(message);
    this.name = 'SchedulesVersionError';
    this.path = path;
    this.fileVersion = fileVersion;
  }
}

/**
 * Load all scheduled task configs from the store.
 * Returns [] when the file is missing or contains invalid JSON.
 *
 * Schema-version guard: if the file is an object with a `version` field that
 * exceeds `SCHEDULES_SCHEMA_VERSION`, or if any entry carries a
 * `_schemaVersion` field that exceeds it, an error is thrown so the caller
 * can surface "upgrade required" rather than silently loading data written for
 * a schema the current code does not understand.  Legacy files (bare JSON
 * array, no version field) are always accepted — backward compatibility is a
 * hard requirement.
 *
 * Read-only: never use this inside a read-modify-write. Its lenient fallback
 * would let a mutation overwrite an unreadable file with only the new state;
 * mutations use `loadSchedulesForWrite` (schedule-store.strict-load.ts).
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
    const parsed: unknown = JSON.parse(raw);

    // Object-wrapped format: a future AFK may write { version: N, tasks: [...] }.
    // Refuse rather than silently cast — the shape is not understood by this build.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const fileVersion = typeof obj['version'] === 'number' ? obj['version'] : undefined;
      if (fileVersion !== undefined && fileVersion > SCHEDULES_SCHEMA_VERSION) {
        throw new SchedulesVersionError(
          storePath,
          `[schedule-store] ${storePath} declares schema version ${fileVersion} ` +
            `but this build only understands version ${SCHEDULES_SCHEMA_VERSION}. ` +
            'Upgrade afk to load this file.',
          fileVersion,
        );
      }
      // Object wrapper with unknown or low version: still refuse —
      // the bare-array format is canonical for all current/older releases.
      throw new SchedulesVersionError(
        storePath,
        `[schedule-store] ${storePath} is not a JSON array. ` +
          `Found an object${fileVersion !== undefined ? ` with version ${fileVersion}` : ''}. ` +
          'Expected a bare JSON array of schedule configs.',
        fileVersion,
      );
    }

    if (!Array.isArray(parsed)) {
      // A primitive value (string, number, boolean, null) is a malformed file,
      // not a version mismatch — use a plain Error rather than SchedulesVersionError
      // so callers that catch SchedulesVersionError for "upgrade required" logic
      // do not misinterpret a corrupt file as a schema incompatibility.
      const kind = parsed === null ? 'null' : typeof parsed;
      throw new Error(
        `[schedule-store] ${storePath} is not a JSON array (found ${kind}). ` +
          'The file appears malformed; repair or remove it and retry.',
      );
    }

    // Per-entry _schemaVersion guard: an individual entry written by a future
    // build may carry _schemaVersion > current.  Refuse the whole file so no
    // entry is silently misinterpreted.  Shared with loadSchedulesForWrite via
    // checkEntrySchemaVersions to keep the logic in one place.
    checkEntrySchemaVersions(
      storePath,
      parsed,
      SCHEDULES_SCHEMA_VERSION,
      (path, message, entryVersion) => {
        throw new SchedulesVersionError(path, message, entryVersion);
      },
    );

    return parsed as ScheduledTaskConfig[];
  } catch (err) {
    // SchedulesVersionError is structural — re-throw so callers can surface
    // "upgrade required" rather than silently returning an empty list.
    if (err instanceof SchedulesVersionError) throw err;
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
  // atomicWriteFile (via writeJsonFile) creates parent dirs (mkdirp: true by default).
  // Config files are not secret, but we keep 0o600 to match prior behaviour.
  writeJsonFile(storePath, configs);
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
  if (config.runAt !== undefined && !isValidIsoDate(config.runAt)) {
    throw new Error(`addSchedule: runAt must be a valid ISO 8601 date string, got: ${String(config.runAt)}`);
  }
  if (config.expiresAt !== undefined && !isValidIsoDate(config.expiresAt)) {
    throw new Error(`addSchedule: expiresAt must be a valid ISO 8601 date string, got: ${String(config.expiresAt)}`);
  }
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedulesForWrite(storePath, SCHEDULES_SCHEMA_VERSION);
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
    const schedules = loadSchedulesForWrite(storePath, SCHEDULES_SCHEMA_VERSION);
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
export type SchedulePatch = Partial<Omit<ScheduledTaskConfig, 'id' | 'createdAt' | 'updatedAt' | 'cwd' | 'runAt' | 'expiresAt'>> & {
  /** Set a new directory path, or pass `null`/`""` to clear the existing one. */
  cwd?: string | null;
  /** Set or clear the one-shot fire time. Pass `null` to clear. */
  runAt?: string | null;
  /** Set or clear the hard expiry. Pass `null` to clear. */
  expiresAt?: string | null;
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
  if (patch.runAt !== undefined && patch.runAt !== null && !isValidIsoDate(patch.runAt)) {
    throw new Error(`updateSchedule: runAt must be a valid ISO 8601 date string, got: ${String(patch.runAt)}`);
  }
  if (patch.expiresAt !== undefined && patch.expiresAt !== null && !isValidIsoDate(patch.expiresAt)) {
    throw new Error(`updateSchedule: expiresAt must be a valid ISO 8601 date string, got: ${String(patch.expiresAt)}`);
  }
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedulesForWrite(storePath, SCHEDULES_SCHEMA_VERSION);
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
      ...(patch.maxAttempts !== undefined ? { maxAttempts: patch.maxAttempts } : {}),
      ...(patch.retryDelayMs !== undefined ? { retryDelayMs: patch.retryDelayMs } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.cwd !== undefined && patch.cwd !== null ? { cwd: patch.cwd } : {}),
      ...(patch.runAt !== undefined && patch.runAt !== null ? { runAt: patch.runAt } : {}),
      ...(patch.expiresAt !== undefined && patch.expiresAt !== null ? { expiresAt: patch.expiresAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    // cwd: null means "clear" — remove the per-task pinning entirely so the task
    // falls back to the daemon-wide AFK_DAEMON_CWD default.
    if (patch.cwd === null) delete updated.cwd;
    // runAt/expiresAt: null means "clear" — remove the field entirely.
    if (patch.runAt === null) delete updated.runAt;
    if (patch.expiresAt === null) delete updated.expiresAt;
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
  // When runAt is set the task is a one-shot; cronExpression must be omitted so
  // validateScheduledTask's mutual-exclusivity check does not throw.  The stored
  // `cron` field acts as a poll-cadence placeholder only (scheduler ticks
  // minutely) and must not be forwarded as cronExpression in that case.
  const includeCron = config.cron !== undefined && config.runAt === undefined;
  return {
    taskId: config.id,
    command: config.command,
    trigger: config.trigger ?? 'cron',
    ...(config.executor !== undefined ? { executor: config.executor } : {}),
    ...(includeCron ? { cronExpression: config.cron } : {}),
    ...(config.notifyOn !== undefined ? { notifyOn: config.notifyOn } : {}),
    ...(config.notifyChat !== undefined ? { notifyChat: config.notifyChat } : {}),
    ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    ...(config.retryDelayMs !== undefined ? { retryDelayMs: config.retryDelayMs } : {}),
    ...(config.cwd !== undefined ? { cwd: expandCwd(config.cwd) } : {}),
    ...(config.runAt !== undefined ? { runAt: config.runAt } : {}),
    ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
  };
}
