/**
 * Delayed LF: fix_of_fix — detect whether a later PR references this session's
 * PR as a fix or regression within the 7-day settlement window.
 *
 * Vote: -1 weak. Can NEVER flip `succeeded` to `failed` on its own (per design
 * decision 1: a PR that merged but needed a follow-up fix is still a success).
 *
 * Implementation reuses extractReferencedPrNumbers and isMergedWithinDays from
 * gh-fix-of-fix.ts patterns, but queries in reverse: for each PR URL in the
 * session artifacts, look up whether any LATER PR was filed that references
 * this session's PR number and was filed within FIX_OF_FIX_WINDOW_DAYS.
 *
 * gh API approach: `gh pr list --json number,body,title,createdAt,state --search
 * "is:pr"` is too broad. Instead we query whether any open/merged PR in the
 * repo has a body or title referencing the session's PR number and was created
 * after the session's settles_after date. Because this requires a broad search,
 * the LF is best-effort: if gh fails we abstain and retry next night.
 *
 * Design note: "fix_of_fix is weak and can never flip succeeded" (design §Resolved
 * decisions 1). The combiner enforces this structurally — a weak -1 alone does
 * not change succeeded to failed.
 */

import type { Vote } from './schema.js';
import { parsePrUrl } from './lf-delayed.js';
import {
  extractReferencedPrNumbers,
  isMergedWithinDays,
  FIX_OF_FIX_WINDOW_DAYS,
} from '../gh-fix-of-fix.js';

// ---------------------------------------------------------------------------
// Injectable exec type
// ---------------------------------------------------------------------------

export type ExecFnFof = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// PR listing helpers
// ---------------------------------------------------------------------------

interface PrListItem {
  number: number;
  body?: string;
  title?: string;
  createdAt?: string;
  state?: string;
  mergedAt?: string | null;
}

function parsePrList(raw: string): PrListItem[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as PrListItem[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LF: fix_of_fix
// ---------------------------------------------------------------------------

/**
 * For each PR in the session's artifacts, search the repo for any later PR
 * whose body or title references this PR's number and was CREATED within
 * FIX_OF_FIX_WINDOW_DAYS of the session settle time.
 *
 * Returns a weak -1 vote for each such reference found. Never returns +1.
 * Abstains on gh errors.
 *
 * @param prUrls     PR URLs from the session artifact list.
 * @param settlesAfter  ISO timestamp when the session settled (used as window start).
 * @param execFn     Injectable exec.
 * @param now        ISO timestamp for observed_at.
 * @param nowDate    Date for window comparison (injectable for tests).
 */
export async function lfFixOfFix(
  prUrls: string[],
  settlesAfter: string | null,
  execFn: ExecFnFof,
  now: string,
  nowDate: Date = new Date(),
): Promise<Vote[]> {
  const votes: Vote[] = [];

  for (const url of prUrls) {
    const parsed = parsePrUrl(url);
    if (parsed === null) continue;

    const recentRefs = await _findFixOfFixRefs(
      parsed.repo,
      parsed.number,
      settlesAfter,
      execFn,
      nowDate,
    );

    for (const refPrNumber of recentRefs) {
      votes.push({
        lf: 'fix_of_fix',
        vote: -1,
        strength: 'weak',
        severity: 'minor',
        evidence: `PR #${refPrNumber} in ${parsed.repo} references ${url} as a fix/regression within ${FIX_OF_FIX_WINDOW_DAYS} days`,
        observed_at: now,
      });
    }
  }

  return votes;
}

async function _findFixOfFixRefs(
  repo: string,
  prNumber: number,
  settlesAfter: string | null,
  execFn: ExecFnFof,
  nowDate: Date,
): Promise<number[]> {
  try {
    // Search for PRs that mention this PR number
    const { stdout } = await execFn('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '50',
      '--search',
      `#${prNumber} in:body`,
      '--json',
      'number,body,title,createdAt,mergedAt',
    ]);

    const prs = parsePrList(stdout);
    const window = settlesAfter ? new Date(settlesAfter) : new Date(0);

    const recentRefs: number[] = [];
    for (const pr of prs) {
      if (pr.number === prNumber) continue; // skip self

      // Only consider PRs created after the session (avoid counting the session itself)
      const createdAt = pr.createdAt ? new Date(pr.createdAt) : new Date(0);
      if (createdAt <= window) continue;

      // Check creation is within the window
      if (!isMergedWithinDays(pr.createdAt ?? '', FIX_OF_FIX_WINDOW_DAYS, nowDate)) {
        // Fall back to checking it was created within window of now
        const windowMs = FIX_OF_FIX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        if (nowDate.getTime() - createdAt.getTime() > windowMs) continue;
      }

      const text = `${pr.title ?? ''} ${pr.body ?? ''}`;
      const refs = extractReferencedPrNumbers(text);
      if (refs.includes(prNumber)) {
        recentRefs.push(pr.number);
      }
    }

    return recentRefs;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Real exec implementation
// ---------------------------------------------------------------------------

import { execFileAsync } from '../../utils/exec-file.js';

const FOF_EXEC_TIMEOUT_MS = 20_000;

export const realExecFnFof: ExecFnFof = (
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync(file, args, { timeout: FOF_EXEC_TIMEOUT_MS, killSignal: 'SIGTERM' }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr }),
  );
