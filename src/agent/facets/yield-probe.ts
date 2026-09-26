/**
 * Yield probe — async git/gh helpers for session yield tracking (#2016).
 *
 * This module is deliberately I/O-only: it reads the current branch from git,
 * queries `gh pr list` to check PR existence and merge state, then patches the
 * cached facet with the result. The pure derive logic in `derive.ts` is left
 * untouched (no I/O there).
 *
 * Design constraints:
 * - Never throws — all errors are caught and result in null fields.
 * - Injected exec for testability (no real child_process in unit tests).
 * - Reads and writes facets through the existing store helpers; never accesses
 *   the session sidecar directly.
 *
 * @module agent/facets/yield-probe
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getFacetCacheDir, validateSessionId } from '../../paths.js';
import { SessionFacetSchema, type SessionFacet } from './schema.js';

// ---------------------------------------------------------------------------
// Injectable exec type (matches promisify(execFile) signature)
// ---------------------------------------------------------------------------

export type ExecFnYield = (
  file: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Git/gh probe helpers
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT_MS = 10_000;

/**
 * Return the short branch name for the cwd, or null on failure.
 *
 * Uses `git symbolic-ref --short HEAD` — non-zero exit means detached HEAD or
 * not a git repo; we return null rather than throwing.
 */
export async function getCurrentBranch(execFn: ExecFnYield, cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFn('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Return the PR state for `branch` via `gh pr list --head <branch> --state all
 * --json state,mergedAt`. Returns `'none'` when no PR exists, otherwise
 * `'merged'`, `'open'`, or `'closed'`.
 *
 * Reuses the same gh JSON shape as `src/agent/branch/branch-prune.ts`.
 */
export async function queryPrState(
  execFn: ExecFnYield,
  branch: string,
  cwd?: string,
): Promise<'merged' | 'open' | 'closed' | 'none' | 'error'> {
  // Guard: branch names starting with '--' would be mis-parsed as gh flags.
  if (branch.startsWith('--')) return 'none';

  try {
    const { stdout } = await execFn(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state'],
      { cwd, timeout: EXEC_TIMEOUT_MS },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return 'none';
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return 'none';
    const first = (parsed as Array<Record<string, unknown>>)[0];
    if (!first || typeof first !== 'object') return 'none';
    const state = typeof first['state'] === 'string' ? first['state'].toLowerCase() : '';
    if (state === 'merged') return 'merged';
    if (state === 'closed') return 'closed';
    if (state === 'open') return 'open';
    return 'none';
  } catch {
    // gh exec failure (not found, auth error, timeout) — distinct from an
    // empty PR list. Return 'error' so the caller can leave yield fields null
    // rather than recording produced_pr=false (which implies gh ran cleanly).
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Facet patch: atomic rewrite of yield fields in the cached facet
// ---------------------------------------------------------------------------

function cachePathFor(sessionId: string, cacheDir: string): string {
  validateSessionId(sessionId);
  return join(cacheDir, `${sessionId}.json`);
}

/**
 * Read the cached facet for `sessionId`, patch its yield_tracking fields, and
 * atomically rewrite the cache file. No-op when the cache entry does not exist.
 *
 * This deliberately does NOT go through `getOrDeriveFacet` to avoid
 * re-deriving the facet (which would reset yield_tracking to null).
 */
export function patchYieldFields(
  sessionId: string,
  produced_pr: boolean,
  pr_merged: boolean | null,
  cacheDir: string = getFacetCacheDir(),
): void {
  const cachePath = cachePathFor(sessionId, cacheDir);
  if (!existsSync(cachePath)) return;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    return; // corrupt cache — leave as-is, will be re-derived on next read
  }

  const parsed = SessionFacetSchema.safeParse(raw);
  if (!parsed.success) return;

  const facet: SessionFacet = {
    ...parsed.data,
    yield_tracking: {
      ...parsed.data.yield_tracking,
      produced_pr,
      pr_merged: produced_pr ? pr_merged : null,
    },
  };

  mkdirSync(dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.yield.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(facet, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, cachePath);
}

// ---------------------------------------------------------------------------
// Top-level: probe + patch
// ---------------------------------------------------------------------------

/**
 * Run the yield probe for `sessionId`:
 *   1. Get the current git branch.
 *   2. Query gh for the PR state on that branch.
 *   3. Patch the cached facet with produced_pr / pr_merged.
 *
 * Never throws — all errors are swallowed. The facet is left with null
 * yield fields when the probe cannot run (no git, no gh, etc.).
 */
export async function writeFacetYield(
  sessionId: string,
  execFn: ExecFnYield,
  cwd?: string,
): Promise<void> {
  const branch = await getCurrentBranch(execFn, cwd);
  if (!branch) return;

  const prState = await queryPrState(execFn, branch, cwd);
  if (prState === 'error') {
    // gh exec failure — leave yield_tracking fields null (probe inconclusive).
    return;
  }
  if (prState === 'none') {
    patchYieldFields(sessionId, false, null);
    return;
  }

  patchYieldFields(sessionId, true, prState === 'merged');
}
