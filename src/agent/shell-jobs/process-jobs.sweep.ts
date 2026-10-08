/**
 * Disk bounds for background process logs.
 *
 * Two independent bounds:
 *   - {@link enforceSessionQuota}: before a new job starts, delete the oldest
 *     logs of SETTLED jobs in this session's directory until the directory is
 *     under quota. Logs of running jobs are never touched.
 *   - {@link scheduleProcessJobSweep}: once per registry construction, after a
 *     short unref'd delay, remove session directories under the process-jobs
 *     root whose newest file is older than 7 days. The current session's
 *     directory is excluded by label.
 *
 * Invariant: both are best-effort and never throw. A failed delete leaves the
 * file in place; a disk-bound helper must never stop a job from starting.
 *
 * @module agent/shell-jobs/process-jobs.sweep
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProcessJobsRoot } from '../../paths.js';

const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_DELAY_MS = 5_000;

interface LogFile { file: string; size: number; mtimeMs: number }

function listFiles(dir: string): LogFile[] {
  const out: LogFile[] = [];
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile()) out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  }
  return out;
}

/**
 * Delete oldest settled-job logs until `dir` totals at most `quotaBytes`.
 * `liveLogPaths` holds the base log path of each running job; its rotation
 * (`<path>.1`) is protected too.
 */
export function enforceSessionQuota(dir: string, quotaBytes: number, liveLogPaths: ReadonlySet<string>): void {
  const files = listFiles(dir);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= quotaBytes) return;
  const isLive = (file: string): boolean =>
    liveLogPaths.has(file) || liveLogPaths.has(file.replace(/\.1$/, ''));
  const candidates = files.filter((f) => !isLive(f.file)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of candidates) {
    if (total <= quotaBytes) break;
    try {
      fs.rmSync(f.file, { force: true });
      total -= f.size;
    } catch { /* leave it */ }
  }
}

/** Remove stale session directories (newest content older than `maxAgeMs`). */
export function sweepProcessJobDirs(
  currentLabel: string,
  now = Date.now(),
  maxAgeMs = SWEEP_MAX_AGE_MS,
  /** Override the sweep root (for tests). Defaults to `getProcessJobsRoot()`. */
  rootOverride?: string,
): void {
  const root = rootOverride ?? getProcessJobsRoot();
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const entry of entries) {
    if (entry === currentLabel) continue;
    const dir = path.join(root, entry);
    try {
      // lstat: never follow a symlink out of the root.
      if (!fs.lstatSync(dir).isDirectory()) continue;
      // Liveness by newest CONTENT mtime: appending to a file does not bump
      // its directory's mtime, so a long-running job's dir looks stale by
      // directory mtime alone.
      // An empty dir falls back to its own mtime, so a dir another afk
      // process just created (before its first log opens) is not removed.
      const newest = listFiles(dir).reduce((m, f) => Math.max(m, f.mtimeMs), 0) || fs.lstatSync(dir).mtimeMs;
      if (now - newest < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

/** Fire-and-forget sweep, deferred and unref'd so it never delays startup. */
export function scheduleProcessJobSweep(currentLabel: string): void {
  const t = setTimeout(() => sweepProcessJobDirs(currentLabel), SWEEP_DELAY_MS);
  t.unref();
}
