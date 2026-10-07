/**
 * Branch prune engine for agent-afk.
 *
 * Classifies remote `afk/*` branches as safe-to-prune or keep, by checking
 * the PR status via the `gh` CLI and whether any commits on the branch are
 * ahead of the base branch (default: `main`).
 *
 * Pure functions + an injectable exec so the logic is fully unit-testable
 * without spawning real git/gh processes.
 *
 * @module agent/branch/branch-prune
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable exec function — same contract as promisify(execFile).
 * Allows tests to inject a stub without real child-process spawns.
 */
export type ExecForBranchPrune = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** PR state as returned by `gh pr list` / `gh pr view`. */
export type PrState = 'open' | 'merged' | 'closed' | 'none';

/**
 * Classification result for a single remote branch.
 *
 * - `prune`  — safe to delete: PR is merged or closed AND no commits are
 *              ahead of the base that aren't already reachable from base.
 * - `keep`   — must retain: PR is open, OR commits exist ahead of base
 *              that don't belong to a merged PR.
 * - `error`  — gh / git invocation failed; skip and warn.
 */
type BranchVerdict = 'prune' | 'keep' | 'error';

export interface BranchCandidate {
  /** Fully-qualified remote branch name, e.g. `origin/afk/my-feature`. */
  remoteBranch: string;
  /** Short name, e.g. `afk/my-feature`. */
  shortName: string;
  /** PR state, or `'none'` when no associated PR was found. */
  prState: PrState;
  /** Number of commits on this branch not reachable from `base`. */
  commitsAhead: number;
  /** Classification verdict. */
  verdict: BranchVerdict;
  /** Human-readable reason explaining the verdict. */
  reason: string;
  /** Error message when verdict is `'error'`. */
  errorDetail?: string;
}

export interface BranchPruneResult {
  /** All classified candidates (both prune and keep). */
  candidates: BranchCandidate[];
  /** Branches actually deleted (only populated when `dryRun: false`). */
  deleted: string[];
  /** Non-fatal warnings (e.g. gh invocation errors on individual branches). */
  warnings: string[];
  /** Whether this was a dry-run (no deletes performed). */
  dryRun: boolean;
}

export interface BranchPruneOptions {
  execFn: ExecForBranchPrune;
  /** Remote name to inspect. Default: `origin`. */
  remote?: string;
  /** Base branch for commit-ahead comparison. Default: `main`. */
  baseBranch?: string;
  /** Branch prefix to filter on. Default: `afk/`. */
  branchPrefix?: string;
  /** When true, do not execute `git push --delete`. Default: true. */
  dryRun?: boolean;
  /** Working directory for git/gh commands. Default: process.cwd(). */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Pure classification helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse `gh pr list` JSON output for a given branch.
 *
 * `gh pr list --head <branch> --state all --json state` returns a JSON array
 * like `[{"state": "MERGED"}]` or `[]` when no PR exists.
 *
 * Maps the gh string states to our `PrState` union. gh returns uppercase
 * (`"OPEN"`, `"MERGED"`, `"CLOSED"`).
 */
export function parseGhPrState(ghOutput: string): PrState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ghOutput.trim());
  } catch {
    return 'none';
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return 'none';
  const first = (parsed as Array<Record<string, unknown>>)[0];
  if (typeof first !== 'object' || first === null) return 'none';
  const state = typeof first['state'] === 'string' ? first['state'].toLowerCase() : '';
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  if (state === 'open') return 'open';
  return 'none';
}

/**
 * Parse `git rev-list --count <base>..<branch>` stdout.
 *
 * Returns 0 on parse failure (conservative: treat unknown state as no ahead).
 */
export function parseCommitsAhead(revListOutput: string): number {
  const n = parseInt(revListOutput.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Given a PR state and a commit-ahead count, produce the verdict and reason.
 *
 * Classification rules (in priority order):
 *  1. PR is open                     → keep  (never prune live work)
 *  2. commitsAhead > 0 AND no merged PR
 *                                    → keep  (unmerged work would be lost)
 *  3. PR is merged OR closed (and no unmerged commits ahead)
 *                                    → prune (work landed or abandoned)
 *  4. No PR found AND commitsAhead = 0
 *                                    → prune (empty/stale orphan)
 *  5. No PR found AND commitsAhead > 0
 *                                    → keep  (no PR context, play it safe)
 */
export function classify(prState: PrState, commitsAhead: number): Pick<BranchCandidate, 'verdict' | 'reason'> {
  if (prState === 'open') {
    return { verdict: 'keep', reason: 'PR is open' };
  }

  if (prState === 'merged') {
    // Even if there are commits "ahead", they landed on the base via the PR
    // merge commit. A non-zero count here means the branch tip still has a
    // different SHA than the merge commit — it's safe once merged.
    return { verdict: 'prune', reason: 'PR merged' };
  }

  if (prState === 'closed') {
    if (commitsAhead > 0) {
      return {
        verdict: 'keep',
        reason: `PR closed but ${commitsAhead} commit(s) ahead of base — possible unmerged work`,
      };
    }
    return { verdict: 'prune', reason: 'PR closed, no commits ahead of base' };
  }

  // prState === 'none'
  if (commitsAhead === 0) {
    return { verdict: 'prune', reason: 'No PR, no commits ahead of base' };
  }
  return {
    verdict: 'keep',
    reason: `No PR found but ${commitsAhead} commit(s) ahead of base — playing it safe`,
  };
}

// ---------------------------------------------------------------------------
// Remote branch listing
// ---------------------------------------------------------------------------

/**
 * List remote branches matching the given prefix.
 *
 * Runs `git ls-remote --heads <remote> <prefix>*` and extracts the short ref
 * names (e.g. `afk/my-feature`).
 */
async function listRemoteBranches(
  execFn: ExecForBranchPrune,
  remote: string,
  branchPrefix: string,
  cwd: string,
): Promise<string[]> {
  const { stdout } = await execFn('git', ['ls-remote', '--heads', remote, `${branchPrefix}*`], { cwd });
  return stdout
    .split('\n')
    .map((line) => {
      // Each line: "<sha>\trefs/heads/<name>"
      const parts = line.split('\trefs/heads/');
      return parts.length === 2 ? (parts[1] ?? '').trim() : '';
    })
    .filter((name) => name.startsWith(branchPrefix));
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Classify all remote `afk/*` branches and optionally delete the stale ones.
 *
 * Never throws — errors on individual branches are captured as `BranchCandidate`
 * entries with `verdict: 'error'` and also appended to `result.warnings`.
 */
export async function runBranchPrune(options: BranchPruneOptions): Promise<BranchPruneResult> {
  const {
    execFn,
    remote = 'origin',
    baseBranch = 'main',
    branchPrefix = 'afk/',
    dryRun = true,
    cwd = process.cwd(),
  } = options;

  const result: BranchPruneResult = {
    candidates: [],
    deleted: [],
    warnings: [],
    dryRun,
  };

  // 1. List remote branches matching the prefix
  let remoteBranches: string[];
  try {
    remoteBranches = await listRemoteBranches(execFn, remote, branchPrefix, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.warnings.push(`[ERROR] Failed to list remote branches from ${remote}: ${msg}`);
    return result;
  }

  if (remoteBranches.length === 0) {
    return result;
  }

  // 2. Classify each branch
  for (const shortName of remoteBranches) {
    const remoteBranch = `${remote}/${shortName}`;

    let prState: PrState = 'none';
    let commitsAhead = 0;

    try {
      // Check PR status via gh CLI
      const ghResult = await execFn(
        'gh',
        ['pr', 'list', '--head', shortName, '--state', 'all', '--json', 'state'],
        { cwd },
      );
      prState = parseGhPrState(ghResult.stdout);
    } catch {
      // gh may not be installed or the branch has no associated repo context
      prState = 'none';
    }

    try {
      // Count commits on this branch not reachable from the base
      const revResult = await execFn(
        'git',
        ['rev-list', '--count', `${baseBranch}..${remote}/${shortName}`],
        { cwd },
      );
      commitsAhead = parseCommitsAhead(revResult.stdout);
    } catch {
      // Branch may not be fetched locally; treat as 0 ahead (conservative for
      // the prune direction: if we can't tell, we rely on prState only)
      commitsAhead = 0;
    }

    const { verdict, reason } = classify(prState, commitsAhead);

    result.candidates.push({
      remoteBranch,
      shortName,
      prState,
      commitsAhead,
      verdict,
      reason,
    });
  }

  // 3. Delete prune-classified branches (when not dry-run)
  if (!dryRun) {
    const toPrune = result.candidates.filter((c) => c.verdict === 'prune');
    for (const candidate of toPrune) {
      try {
        await execFn('git', ['push', remote, '--delete', candidate.shortName], { cwd });
        result.deleted.push(candidate.shortName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push(`[ERROR] Failed to delete ${candidate.shortName}: ${msg}`);
        // Update the verdict so the output is accurate
        candidate.verdict = 'error';
        candidate.errorDetail = msg;
      }
    }
  }

  return result;
}
