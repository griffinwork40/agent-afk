/**
 * 7-day disk eviction sweep for background-job log directories.
 *
 * Extracted from background-registry.ts: removes bg job directories whose
 * `meta.json` shows `endedAt` older than 7 days. Called once on registry
 * construction after a 5-second delay. Errors per-directory are logged
 * and do not abort the sweep.
 *
 * @module agent/background-registry.sweep
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getBgJobsRoot, getBgJobDir } from '../paths.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function sweepOldBgJobs(): Promise<void> {
  const root = getBgJobsRoot();
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return; // root doesn't exist yet — nothing to sweep
  }
  for (const entry of entries) {
    const jobDir = getBgJobDir(entry);
    const metaPath = path.join(jobDir, 'meta.json');
    try {
      // Symlink guard: lstat does not follow symlinks — skip anything that
      // isn't a plain directory so we don't recursively remove symlink targets
      // outside the jobs root.
      const dirStat = await fsp.lstat(jobDir);
      if (!dirStat.isDirectory()) {
        process.stderr.write(`[afk] bg sweep: skipping non-directory entry ${entry}\n`);
        continue;
      }
      const raw = await fsp.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw) as { endedAt?: number; status?: string };
      // Only evict terminal jobs
      if (meta.status === 'running') continue;
      if (meta.endedAt === undefined) continue;
      if (Date.now() - meta.endedAt < SEVEN_DAYS_MS) continue;
      await fsp.rm(jobDir, { recursive: true, force: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // already gone
      process.stderr.write(`[afk] bg sweep: error evicting ${entry}: ${String(e)}\n`);
    }
  }
}
