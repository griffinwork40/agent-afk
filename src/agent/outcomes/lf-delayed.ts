/**
 * Delayed labeling functions — run after session teardown when external state
 * (GitHub, git history) has settled.
 *
 * LFs here:
 *   - pr_fate       : gh pr view → merged (+1 strong) / closed unmerged (-1 strong)
 *   - commit_survival : SHA ancestor of origin default branch (+1 strong);
 *                       -1 if a revert commit exists
 *   - fix_of_fix    : skipped in M0 (stated below)
 *
 * All external calls (gh, git) are injected so unit tests need no network/FS.
 */

import type { Vote } from './schema.js';

// ---------------------------------------------------------------------------
// Injectable exec functions
// ---------------------------------------------------------------------------

/** Result of running `gh pr view <n> --repo <o/r> --json state,mergedAt` */
export interface PrState {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
}

/** Injectable: call gh pr view. Returns null on failure. */
export type FetchPrState = (prUrl: string) => Promise<PrState | null>;

/** Injectable: check if a SHA is an ancestor of origin/<default> in a local repo. */
export type CheckAncestor = (
  sha: string,
  repoPath: string,
) => Promise<boolean>;

/** Injectable: check for a revert of a SHA in the git log. */
export type CheckRevert = (sha: string, repoPath: string) => Promise<boolean>;

/** Resolve the default remote branch name for a repo (e.g. "main"). */
export type GetDefaultBranch = (repoPath: string) => Promise<string>;

// ---------------------------------------------------------------------------
// PR URL parsing
// ---------------------------------------------------------------------------

const PR_URL_RE =
  /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

export function parsePrUrl(
  url: string,
): { repo: string; number: number } | null {
  const m = PR_URL_RE.exec(url);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { repo: m[1], number: parseInt(m[2], 10) };
}

// ---------------------------------------------------------------------------
// LF: pr_fate
// ---------------------------------------------------------------------------

/**
 * Votes +1 (strong) if the PR merged, -1 (strong) if closed unmerged.
 * Abstains (0) if still open or state is unavailable.
 */
export async function lfPrFate(
  prUrls: string[],
  fetchPrState: FetchPrState,
  now: string,
): Promise<Vote[]> {
  const votes: Vote[] = [];
  for (const url of prUrls) {
    const parsed = parsePrUrl(url);
    if (parsed === null) continue;

    const state = await fetchPrState(url);
    if (state === null) continue;

    if (state.state === 'MERGED') {
      votes.push({
        lf: 'pr_fate',
        vote: 1,
        strength: 'strong',
        evidence: `PR ${url} state=MERGED mergedAt=${state.mergedAt ?? 'unknown'}`,
        observed_at: now,
      });
    } else if (state.state === 'CLOSED') {
      votes.push({
        lf: 'pr_fate',
        vote: -1,
        strength: 'strong',
        evidence: `PR ${url} state=CLOSED (unmerged)`,
        observed_at: now,
      });
    }
    // OPEN → abstain (0); no vote pushed
  }
  return votes;
}

// ---------------------------------------------------------------------------
// LF: commit_survival
// ---------------------------------------------------------------------------

/**
 * Votes +1 (strong) if the SHA is an ancestor of origin/<default> after 7 days.
 * Votes -1 (strong) if a revert commit exists for the SHA.
 * Abstains if the repo path is unavailable or not a git repo.
 */
export async function lfCommitSurvival(
  commits: string[],
  repoPath: string | null,
  checkAncestor: CheckAncestor,
  checkRevert: CheckRevert,
  now: string,
): Promise<Vote[]> {
  if (repoPath === null || commits.length === 0) return [];

  const votes: Vote[] = [];
  for (const sha of commits) {
    // Check for revert first — overrides survival
    const reverted = await checkRevert(sha, repoPath);
    if (reverted) {
      votes.push({
        lf: 'commit_survival',
        vote: -1,
        strength: 'strong',
        evidence: `SHA ${sha} has a "This reverts commit ${sha}" in git log`,
        observed_at: now,
      });
      continue;
    }

    const survived = await checkAncestor(sha, repoPath);
    if (survived) {
      votes.push({
        lf: 'commit_survival',
        vote: 1,
        strength: 'strong',
        evidence: `SHA ${sha} is ancestor of origin default branch`,
        observed_at: now,
      });
    }
    // Not yet an ancestor → abstain (might be squash-merged; pr_fate handles that)
  }
  return votes;
}

// ---------------------------------------------------------------------------
// LF: fix_of_fix — SKIPPED in M0
// ---------------------------------------------------------------------------

/**
 * fix_of_fix: skipped in M0.
 *
 * Rationale: requires cross-session PR graph queries (gh API or gh-fix-of-fix.ts
 * patterns) that add significant complexity and latency. The design marks it
 * as "may be skipped in M0 if costly". It is weak (-1) and cannot flip
 * `succeeded` on its own, so omitting it does not materially affect the M0
 * label distribution. It will be implemented in M2 alongside the daemon job.
 */
export function lfFixOfFix(): Vote[] {
  return []; // Always abstains in M0
}

// ---------------------------------------------------------------------------
// Real exec implementations (used by the backfill script, not by unit tests)
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const realFetchPrState: FetchPrState = async (
  prUrl: string,
): Promise<PrState | null> => {
  const parsed = parsePrUrl(prUrl);
  if (parsed === null) return null;
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr',
      'view',
      String(parsed.number),
      '--repo',
      parsed.repo,
      '--json',
      'state,mergedAt',
    ]);
    const data = JSON.parse(stdout) as { state?: string; mergedAt?: string | null };
    const state = (data.state ?? 'OPEN') as PrState['state'];
    const mergedAt = data.mergedAt ?? null;
    return { state, mergedAt };
  } catch {
    return null;
  }
};

export const realCheckAncestor: CheckAncestor = async (
  sha: string,
  repoPath: string,
): Promise<boolean> => {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', sha, 'origin/HEAD'], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
};

export const realCheckRevert: CheckRevert = async (
  sha: string,
  repoPath: string,
): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--oneline', `--grep=This reverts commit ${sha}`],
      { cwd: repoPath },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
};
