/**
 * Persistent store for scheduled task configurations.
 *
 * Persists to `~/.afk/config/schedules.json` (default). All writes are
 * atomic (temp + rename) to avoid leaving a half-written file. Missing file
 * returns an empty array. JSON parse failures log to stderr and return [].
 *
 * @module agent/daemon/schedule-store
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getSchedulesPath } from '../../paths.js';
import type { ScheduledTask } from './triggers.js';

export interface ScheduledTaskConfig {
  /** Slug ID, e.g. "nightly-forge". Auto-generated from `name` via `slugify`. */
  id: string;
  /** Human-readable label, e.g. "Nightly forge friction". */
  name: string;
  /** Command sent to the spawned session, e.g. "/forge-friction --auto". */
  command: string;
  /** 5- or 6-field cron expression, e.g. "0 2 * * *". */
  cron: string;
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
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * Load all scheduled task configs from the store.
 * Returns [] when the file is missing or contains invalid JSON.
 */
export function loadSchedules(path?: string): ScheduledTaskConfig[] {
  const storePath = path ?? getSchedulesPath();
  if (!existsSync(storePath)) return [];
  try {
    const raw = readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as ScheduledTaskConfig[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
 */
export function addSchedule(
  config: Omit<ScheduledTaskConfig, 'id' | 'createdAt' | 'updatedAt'>,
  path?: string,
): ScheduledTaskConfig {
  const schedules = loadSchedules(path);
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
  saveSchedules(schedules, path);
  return newConfig;
}

/**
 * Remove a schedule by ID. Returns true if removed, false if not found.
 */
export function removeSchedule(id: string, path?: string): boolean {
  const schedules = loadSchedules(path);
  const before = schedules.length;
  const filtered = schedules.filter((s) => s.id !== id);
  if (filtered.length === before) return false;
  saveSchedules(filtered, path);
  return true;
}

/**
 * Get a single schedule by ID. Returns undefined if not found.
 */
export function getSchedule(id: string, path?: string): ScheduledTaskConfig | undefined {
  return loadSchedules(path).find((s) => s.id === id);
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
 */
export function toScheduledTask(config: ScheduledTaskConfig): ScheduledTask {
  return {
    taskId: config.id,
    command: config.command,
    trigger: config.trigger ?? 'cron',
    ...(config.cron !== undefined ? { cronExpression: config.cron } : {}),
    ...(config.notifyOn !== undefined ? { notifyOn: config.notifyOn } : {}),
  };
}
