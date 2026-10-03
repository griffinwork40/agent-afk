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
 * - Never downgrades produced_pr=true to false (#2777): derive.ts may detect
 *   a PR from `gh pr create` output; the probe must not erase that signal.
 * - When pr_url is present, determine pr_merged via `gh pr view <url> --json
 *   state` instead of the cwd branch (#2777).
 *
 * @module agent/facets/yield-probe
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

// Invariant: only a well-formed GitHub PR URL is passed to gh pr view.
// A value starting with '-' would be mis-parsed as a flag; other malformed
// values could produce surprising gh output. Validated before any exec call.
const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

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

/**
 * Return the PR state for a known PR URL via `gh pr view <url> --json state`.
 * Returns `'merged'`, `'open'`, `'closed'`, or `'error'` on failure.
 *
 * Used when derive.ts detected a `gh pr create` URL — avoids the cwd branch
 * lookup entirely, since the URL uniquely identifies the PR (#2777).
 */
export async function queryPrStateByUrl(
  execFn: ExecFnYield,
  prUrl: string,
  cwd?: string,
): Promise<'merged' | 'open' | 'closed' | 'error'> {
  // Guard: reject malformed or flag-like values before passing to gh.
  if (!GITHUB_PR_URL_RE.test(prUrl)) return 'error';
  try {
    const { stdout } = await execFn(
      'gh',
      ['pr', 'view', '--json', 'state', '--', prUrl],
      { cwd, timeout: EXEC_TIMEOUT_MS },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return 'error';
    }
    if (!parsed || typeof parsed !== 'object') return 'error';
    const obj = parsed as Record<string, unknown>;
    const state = typeof obj['state'] === 'string' ? obj['state'].toLowerCase() : '';
    if (state === 'merged') return 'merged';
    if (state === 'closed') return 'closed';
    if (state === 'open') return 'open';
    return 'error';
  } catch {
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
 * Contract (#2777):
 * - Never downgrades produced_pr=true to false — if the cached facet already
 *   has produced_pr=true (set by derive.ts from gh pr create output), leave it.
 * - Carries forward pr_url from the cached facet when not supplying a new one.
 *
 * This deliberately does NOT go through `getOrDeriveFacet` to avoid
 * re-deriving the facet (which would reset yield_tracking to null).
 */
export function patchYieldFields(
  sessionId: string,
  produced_pr: boolean,
  pr_merged: boolean | null,
  cacheDir: string = getFacetCacheDir(),
  pr_url?: string | null,
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

  const existing = parsed.data;
  const existingYt = existing.yield_tracking;

  // Never downgrade produced_pr=true to false (#2777).
  const effectiveProducedPr = existingYt.produced_pr === true ? true : produced_pr;
  // Keep existing pr_url if new one is not provided and existing is non-null
  const effectivePrUrl = pr_url !== undefined ? pr_url
    : (existingYt.pr_url !== undefined ? existingYt.pr_url : null);

  const facet: SessionFacet = {
    ...existing,
    yield_tracking: {
      ...existingYt,
      produced_pr: effectiveProducedPr,
      pr_merged: effectiveProducedPr ? pr_merged : null,
      pr_url: effectivePrUrl,
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
 *   1. Check if the cached facet already has a pr_url (from gh pr create detection).
 *      If so, query gh pr view <url> --json state directly.
 *   2. Otherwise, get the current git branch and query gh pr list --head <branch>.
 *   3. Patch the cached facet with produced_pr / pr_merged.
 *
 * Contract (#2777):
 * - Never throws — all errors are swallowed.
 * - Never downgrades existing produced_pr=true to false.
 * - When pr_url is present in the existing cached facet, uses gh pr view <url>
 *   to determine pr_merged (avoids branch-name ambiguity).
 */
export async function writeFacetYield(
  sessionId: string,
  execFn: ExecFnYield,
  cwd?: string,
): Promise<void> {
  // Read the cached facet to check for a pre-detected pr_url
  const cacheDir = getFacetCacheDir();
  const cachePath = cachePathFor(sessionId, cacheDir);
  let cachedPrUrl: string | null | undefined;
  let cachedProducedPr: boolean | null = null;

  if (existsSync(cachePath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
      const parsed = SessionFacetSchema.safeParse(raw);
      if (parsed.success) {
        cachedPrUrl = parsed.data.yield_tracking.pr_url;
        cachedProducedPr = parsed.data.yield_tracking.produced_pr;
      }
    } catch {
      // ignore read errors
    }
  }

  // Path 1: pr_url already detected by derive.ts — query by URL directly
  if (typeof cachedPrUrl === 'string' && cachedPrUrl.length > 0) {
    const prState = await queryPrStateByUrl(execFn, cachedPrUrl, cwd);
    if (prState === 'error') return; // leave fields as-is, probe inconclusive
    patchYieldFields(sessionId, true, prState === 'merged', cacheDir, cachedPrUrl);
    return;
  }

  // Path 2: no detected pr_url — branch-based lookup
  const branch = await getCurrentBranch(execFn, cwd);
  if (!branch) return;

  const prState = await queryPrState(execFn, branch, cwd);
  if (prState === 'error') {
    // gh exec failure — leave yield_tracking fields null (probe inconclusive).
    return;
  }
  if (prState === 'none') {
    // Never downgrade produced_pr=true to false — if derive already detected
    // a PR URL, don't record false just because branch lookup found nothing.
    if (cachedProducedPr === true) return;
    patchYieldFields(sessionId, false, null);
    return;
  }

  patchYieldFields(sessionId, true, prState === 'merged');
}
