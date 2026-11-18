/**
 * Cross-repository worktree inventory.
 *
 * Runs a dry-run sweep across every registered repo root (via
 * `readRegisteredWorktreeRoots`) and collects one row per managed worktree.
 * Optionally probes each checkout's disk usage via `du -sk`.
 *
 * This module is intentionally read-only: it never removes or modifies any
 * worktree. All sweep calls are made with `dryRun: true`.
 *
 * @module agent/worktree/worktree-inventory
 */

import { execFile as execFileCallback } from 'node:child_process';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { readRegisteredWorktreeRoots } from './worktree-root-registry.js';
import { runSweep } from './worktree-sweep.js';
import type { ExecFileFn, SweepResult } from './worktree-sweep.js';
import { errorMessage } from '../../utils/errors.js';

const defaultExecFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InventoryRow {
  /** Absolute path to the worktree checkout. */
  path: string;
  /** Absolute path to the git repository root that owns this worktree. */
  repoRoot: string;
  /** Short branch name (e.g. `afk/my-feature`), or empty string for detached HEAD. */
  branch: string;
  /** Resolved owner: 'interactive' | 'diagnose' | 'unknown'. */
  owner: 'interactive' | 'diagnose' | 'unknown';
  /** Age in milliseconds since creation. */
  ageMs: number;
  /** Sweep verdict. */
  verdict: string;
  /** Raw git lock reason, or undefined when not locked. */
  lockReason?: string;
  /**
   * Plain-language description of what is keeping the tree alive and what
   * would make it reclaimable. Empty string for clean/active trees.
   */
  blocker: string;
  /**
   * Disk usage in kilobytes (1 KiB blocks), or undefined when the probe was
   * skipped (e.g. `--no-size`) or the directory no longer exists on disk.
   */
  diskKb?: number;
}

export interface RepoSummary {
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** All managed worktrees found in this repo. */
  rows: InventoryRow[];
  /** Total disk usage of all worktrees in this repo (KiB). Present when size was probed. */
  totalDiskKb?: number;
  /** Warnings produced by the sweep (e.g. git errors, contested lock). */
  warnings: string[];
  /**
   * True when the sweep lock was contested and this repo was not inspected.
   * The rows array will be empty.
   */
  contested: boolean;
}

export interface InventoryResult {
  repos: RepoSummary[];
  /** Total rows across all repos. */
  totalRows: number;
  /** Total disk usage across all repos (KiB). Present when size was probed. */
  totalDiskKb?: number;
  /**
   * Repo roots that have a `.afk-worktrees/` directory on disk but are absent
   * from the registry. These trees are invisible to the sweep engine.
   */
  unregisteredRoots: string[];
}

export interface InventoryOptions {
  execFile?: ExecFileFn;
  /**
   * When true, probe each worktree checkout's disk usage via `du -sk`.
   * Defaults to true. Pass false to skip for speed.
   */
  includeSize?: boolean;
  /**
   * Additional repo roots to include beyond the registry (e.g. the caller's
   * own repo root). De-duplicated before scanning.
   */
  extraRoots?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Probe disk usage of a directory via `du -sk`.
 * Returns KiB, or undefined on any error (directory gone, permission denied).
 */
async function probeDiskKb(
  execFile: ExecFileFn,
  dirPath: string,
): Promise<number | undefined> {
  try {
    const result = await execFile('du', ['-sk', dirPath]);
    const kbStr = result.stdout.trim().split(/\s+/)[0];
    if (kbStr === undefined) return undefined;
    const kb = parseInt(kbStr, 10);
    return Number.isFinite(kb) ? kb : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check whether `<repoRoot>/.afk-worktrees/` exists on disk but the root is
 * absent from the registry. These are "invisible" repos.
 */
async function findUnregisteredRoots(
  roots: string[],
  registeredSet: Set<string>,
): Promise<string[]> {
  const unregistered: string[] = [];
  for (const root of roots) {
    if (registeredSet.has(root)) continue;
    const afkDir = join(root, '.afk-worktrees');
    try {
      const st = await fs.stat(afkDir);
      if (st.isDirectory()) unregistered.push(root);
    } catch { /* not found or inaccessible — skip */ }
  }
  return unregistered;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Collect a cross-repository inventory of all afk-managed worktrees.
 *
 * Reads the worktree root registry, runs a dry-run sweep per repo, and
 * optionally probes disk usage. Returns one {@link InventoryRow} per
 * managed worktree, grouped by repository in {@link RepoSummary}.
 *
 * Always read-only — never removes or modifies any worktree.
 */
export async function runInventory(options: InventoryOptions = {}): Promise<InventoryResult> {
  const execFile = options.execFile ?? defaultExecFile;
  const includeSize = options.includeSize !== false;

  // Collect all roots: registered + any extras the caller supplies.
  const registered = await readRegisteredWorktreeRoots();
  const registeredSet = new Set(registered);

  const allRoots = [...registered];
  for (const extra of options.extraRoots ?? []) {
    if (!registeredSet.has(extra)) allRoots.push(extra);
  }

  // Identify any extra roots that have an .afk-worktrees dir but are not
  // registered (the caller may pass their own repo root as an extra).
  const unregisteredRoots = await findUnregisteredRoots(
    options.extraRoots ?? [],
    registeredSet,
  );

  const repos: RepoSummary[] = [];

  for (const repoRoot of allRoots) {
    let sweepResult: SweepResult;
    try {
      sweepResult = await runSweep({
        execFile,
        repoRoot,
        dryRun: true,
        scope: 'all',
        // Bypass the soft-launch valve: inventory is always dry-run, so
        // forcing another preview round here would just waste the counter.
        bypassSoftLaunch: true,
      });
    } catch (err) {
      repos.push({
        repoRoot,
        rows: [],
        warnings: [`[ERROR] sweep failed: ${errorMessage(err)}`],
        contested: false,
      });
      continue;
    }

    const rows: InventoryRow[] = [];
    let totalDiskKb: number | undefined = includeSize ? 0 : undefined;

    for (const c of sweepResult.candidates) {
      let diskKb: number | undefined;
      if (includeSize) {
        diskKb = await probeDiskKb(execFile, c.path);
        if (diskKb !== undefined && totalDiskKb !== undefined) {
          totalDiskKb += diskKb;
        }
      }

      rows.push({
        path: c.path,
        repoRoot,
        branch: c.branch,
        owner: c.owner,
        ageMs: c.ageMs,
        verdict: c.verdict,
        lockReason: c.lockReason,
        blocker: c.blocker,
        ...(includeSize ? { diskKb } : {}),
      });
    }

    repos.push({
      repoRoot,
      rows,
      ...(includeSize ? { totalDiskKb } : {}),
      warnings: sweepResult.warnings,
      contested: sweepResult.contested ?? false,
    });
  }

  const totalRows = repos.reduce((n, r) => n + r.rows.length, 0);
  const totalDiskKb = includeSize
    ? repos.reduce((n, r) => n + (r.totalDiskKb ?? 0), 0)
    : undefined;

  return {
    repos,
    totalRows,
    ...(includeSize ? { totalDiskKb } : {}),
    unregisteredRoots,
  };
}
