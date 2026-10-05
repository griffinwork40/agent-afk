/**
 * Delayed LF: ci — check `gh pr checks` conclusion for the session's PRs.
 *
 * Vote: +1 weak if all checks passed, -1 weak if any check failed.
 * Abstains when gh is unavailable, the PR has no checks, or checks are pending.
 *
 * This is intentionally weak — CI can fail for infrastructure reasons unrelated
 * to the agent's work (flaky tests, billing limits, capacity). The vote is
 * purely advisory; it cannot flip a strong label on its own.
 */

import type { Vote } from './schema.js';
import { parsePrUrl } from './lf-delayed.js';

// ---------------------------------------------------------------------------
// Injectable exec type (mirrors gh-fix-of-fix.ts pattern)
// ---------------------------------------------------------------------------

export type ExecFnCi = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// CI check status helpers
// ---------------------------------------------------------------------------

interface CheckRun {
  conclusion?: string | null;
  status?: string;
}

function parseChecks(raw: string): CheckRun[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as CheckRun[];
  } catch {
    return [];
  }
}

function checksConclusion(
  checks: CheckRun[],
): 'passed' | 'failed' | 'pending' | 'none' {
  if (checks.length === 0) return 'none';
  const pending = checks.some(
    (c) => !c.conclusion || c.conclusion === 'pending' || c.status === 'in_progress',
  );
  if (pending) return 'pending';
  const failed = checks.some(
    (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out',
  );
  return failed ? 'failed' : 'passed';
}

// ---------------------------------------------------------------------------
// LF: ci
// ---------------------------------------------------------------------------

/**
 * Run `gh pr checks <n> --repo <o/r> --json conclusion,status` for each PR
 * URL. Votes weak +1 if all resolved and passed, weak -1 if any failed.
 * Abstains when gh errors, when checks are still pending, or when there are no checks.
 *
 * @param prUrls   PR URLs from the session artifact list.
 * @param execFn   Injectable exec (real: default gh execFile; tests: fake).
 * @param now      ISO timestamp for observed_at.
 * @param cache    Mutable cache keyed by PR URL; populated in-place so callers
 *                 can share one cache across LFs without re-fetching.
 */
export async function lfCi(
  prUrls: string[],
  execFn: ExecFnCi,
  now: string,
  cache: Map<string, 'passed' | 'failed' | 'pending' | 'none' | 'error'> = new Map(),
): Promise<Vote[]> {
  const votes: Vote[] = [];

  for (const url of prUrls) {
    const parsed = parsePrUrl(url);
    if (parsed === null) continue;

    let conclusion = cache.get(url);
    if (conclusion === undefined) {
      conclusion = await _fetchChecks(parsed.repo, parsed.number, execFn);
      cache.set(url, conclusion);
    }

    if (conclusion === 'passed') {
      votes.push({
        lf: 'ci',
        vote: 1,
        strength: 'weak',
        evidence: `gh pr checks ${url}: all passed`,
        observed_at: now,
      });
    } else if (conclusion === 'failed') {
      votes.push({
        lf: 'ci',
        vote: -1,
        strength: 'weak',
        evidence: `gh pr checks ${url}: one or more checks failed`,
        observed_at: now,
      });
    }
    // pending, none, error → abstain
  }

  return votes;
}

async function _fetchChecks(
  repo: string,
  prNumber: number,
  execFn: ExecFnCi,
): Promise<'passed' | 'failed' | 'pending' | 'none' | 'error'> {
  try {
    const { stdout } = await execFn('gh', [
      'pr',
      'checks',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'conclusion,status',
    ]);
    const checks = parseChecks(stdout);
    return checksConclusion(checks);
  } catch {
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Real exec implementation
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CI_EXEC_TIMEOUT_MS = 20_000;

export const realExecFnCi: ExecFnCi = (
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync(file, args, { timeout: CI_EXEC_TIMEOUT_MS, killSignal: 'SIGTERM' }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr }),
  );
