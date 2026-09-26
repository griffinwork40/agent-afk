/**
 * Fix-of-fix cross-reference detector for the /ship skill.
 *
 * Detects when a PR body references another recently-merged PR and applies
 * a `fix-of-fix` label. This enables the weekly `fix-of-fix PRs / total PRs`
 * metric to be computed from GitHub labels without a full audit.
 *
 * ## Patterns detected
 *
 *   - `#NNNN`                       — bare issue/PR reference
 *   - `fix(#NNNN)`                  — conventional-commit cross-reference
 *   - `regression from #NNNN`       — explicit regression attribution
 *   - `follow-up to #NNNN`          — follow-up annotation
 *   - `addresses #NNNN`             — review-response reference
 *   - `fixes #NNNN` / `closes #N`  — standard GitHub close-keyword
 *
 * A referenced PR is considered "recently merged" when its `mergedAt`
 * timestamp falls within `FIX_OF_FIX_WINDOW_DAYS` days of the check time.
 *
 * ## Machine-readable metadata
 *
 * When a fix-of-fix relationship is detected, the caller receives the list of
 * referenced PR numbers so a structured cross-reference section can be appended
 * to the PR body for downstream tooling.
 *
 * @module agent/gh-fix-of-fix
 */

import type { ExecFn } from './gh.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** PRs merged within this many days qualify as "recently merged" for fix-of-fix. */
export const FIX_OF_FIX_WINDOW_DAYS = 7;

/** Label applied to PRs that reference a recently-merged PR. */
export const FIX_OF_FIX_LABEL = 'fix-of-fix';

/**
 * Exec timeout for `gh` calls in this module (20 s, matching gh.ts convention).
 * @internal
 */
const EXEC_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultExecFn(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGTERM' }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr }),
  );
}

// ---------------------------------------------------------------------------
// PR reference extraction
// ---------------------------------------------------------------------------

/**
 * Regex patterns for fix-of-fix cross-references. Each pattern must capture
 * the PR number in capture group 1. Tested in order; duplicates are collapsed.
 *
 * Anchored to word boundaries / non-digit contexts so `#1` inside `#10` is
 * not double-matched.
 */
const REFERENCE_PATTERNS: RegExp[] = [
  // fix(#NNNN) — conventional commit style
  /\bfix\s*\(\s*#(\d+)\s*\)/gi,
  // regression from #NNNN
  /regression\s+from\s+#(\d+)/gi,
  // follow-up to #NNNN
  /follow-?up\s+to\s+#(\d+)/gi,
  // addresses #NNNN
  /addresses\s+#(\d+)/gi,
  // fixes / closes / resolves #NNNN (GitHub close-keywords — kept for completeness)
  /\b(?:fixes?|closes?|resolves?)\s+#(\d+)/gi,
  // bare #NNNN (must come last — broadest pattern)
  /#(\d+)/g,
];

/**
 * Extract all PR/issue numbers referenced in `text`. Returns a de-duplicated
 * array of numbers in the order first encountered (by minimum number of the
 * first-match position, effectively document order).
 */
export function extractReferencedPrNumbers(text: string): number[] {
  const seen = new Set<number>();
  const results: number[] = [];

  for (const pattern of REFERENCE_PATTERNS) {
    // Reset lastIndex for global regexes (they are shared instances here).
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const captured = m[1];
      if (captured === undefined) continue;
      const n = parseInt(captured, 10);
      if (!seen.has(n)) {
        seen.add(n);
        results.push(n);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Merge-date check
// ---------------------------------------------------------------------------

/**
 * Resolve the `mergedAt` ISO timestamp for a PR, or `null` when the PR is
 * not merged / does not exist / `gh` fails. Never throws.
 */
export async function getPrMergedAt(
  prNumber: number,
  execFn?: ExecFn,
): Promise<string | null> {
  const exec = execFn ?? defaultExecFn;
  try {
    const { stdout } = await exec('gh', [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'mergedAt',
      '--jq',
      '.mergedAt',
    ]);
    const val = stdout.trim();
    // `gh` outputs `null` (literal string) when the PR is not merged.
    return val && val !== 'null' ? val : null;
  } catch {
    return null;
  }
}

/**
 * Return `true` when `mergedAt` (ISO string from GitHub) is within
 * `withinDays` calendar days of `now`.
 */
export function isMergedWithinDays(
  mergedAt: string,
  withinDays: number,
  now: Date = new Date(),
): boolean {
  const mergedMs = new Date(mergedAt).getTime();
  if (Number.isNaN(mergedMs)) return false;
  const windowMs = withinDays * 24 * 60 * 60 * 1000;
  return now.getTime() - mergedMs <= windowMs;
}

// ---------------------------------------------------------------------------
// Label management
// ---------------------------------------------------------------------------

/**
 * Ensure the `fix-of-fix` label exists on the repo. Creates it (gold colour)
 * if absent. Never throws — label creation is best-effort.
 */
export async function ensureFixOfFixLabel(execFn?: ExecFn): Promise<void> {
  const exec = execFn ?? defaultExecFn;
  try {
    // Check if label exists
    await exec('gh', ['label', 'list', '--search', FIX_OF_FIX_LABEL, '--json', 'name']);
    // Create is idempotent — GitHub returns 422 if it already exists, which we swallow.
    await exec('gh', [
      'label',
      'create',
      FIX_OF_FIX_LABEL,
      '--description',
      'PR that fixes a bug introduced by a recently-merged PR (merged within 7 days)',
      '--color',
      'D93F0B', // GitHub "red-orange" — conventional for regressions
      '--force',  // update if exists
    ]);
  } catch {
    // Best-effort; if label creation fails the PR label step will also fail and
    // be reported separately.
  }
}

/**
 * Apply the `fix-of-fix` label to a PR. Never throws.
 */
export async function applyFixOfFixLabel(
  prNumber: number | string,
  execFn?: ExecFn,
): Promise<void> {
  const exec = execFn ?? defaultExecFn;
  try {
    await exec('gh', ['pr', 'edit', String(prNumber), '--add-label', FIX_OF_FIX_LABEL]);
  } catch {
    // Best-effort — the PR is already open; the label is an annotation, not the deliverable.
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Result from `detectAndLabelFixOfFix`.
 */
export interface FixOfFixResult {
  /** Whether this PR was classified as a fix-of-fix. */
  isFixOfFix: boolean;
  /**
   * PR numbers that were referenced in the body AND were merged within the
   * look-back window. Empty when `isFixOfFix` is false.
   */
  recentlyMergedRefs: number[];
  /**
   * All PR numbers found in the body/title text (before the merge-date check).
   * Useful for the structured metadata section in the PR body.
   */
  allRefs: number[];
}

/**
 * Full fix-of-fix detection pipeline for use in the `/ship` skill after PR
 * creation:
 *
 * 1. Extract all `#NNNN` references from `prBodyOrTitle`.
 * 2. For each reference, check `gh pr view <n> --json mergedAt`.
 * 3. If any referenced PR was merged within `FIX_OF_FIX_WINDOW_DAYS` days:
 *    a. Ensure the `fix-of-fix` label exists on the repo.
 *    b. Apply the label to `currentPrNumber`.
 * 4. Return `{ isFixOfFix, recentlyMergedRefs, allRefs }`.
 *
 * Never throws — all `gh` errors are swallowed and an empty result is returned.
 *
 * @param currentPrNumber  The number (or URL) of the PR that was just opened.
 * @param prBodyOrTitle    The PR body and/or title to scan for references.
 * @param opts             Injectable exec/clock for testing.
 */
export async function detectAndLabelFixOfFix(
  currentPrNumber: number | string,
  prBodyOrTitle: string,
  opts: {
    execFn?: ExecFn;
    now?: Date;
    windowDays?: number;
  } = {},
): Promise<FixOfFixResult> {
  const { execFn, now, windowDays = FIX_OF_FIX_WINDOW_DAYS } = opts;

  const allRefs = extractReferencedPrNumbers(prBodyOrTitle);
  if (allRefs.length === 0) {
    return { isFixOfFix: false, recentlyMergedRefs: [], allRefs: [] };
  }

  // Exclude the current PR itself from the check (self-references are common).
  // `currentPrNumber` may be a full GitHub URL (e.g. `https://github.com/owner/repo/pull/200`)
  // because `gh pr create` outputs a URL string, not a bare number, when the caller does not
  // post-process its stdout.  `parseInt('https://…', 10)` returns NaN, so the guard would never
  // fire for URL-form input.  Extract the trailing numeric segment first.
  function parsePrNumber(raw: number | string): number {
    if (typeof raw === 'number') return raw;
    const urlMatch = raw.match(/\/pull\/(\d+)(?:[/?#].*)?$/);
    if (urlMatch?.[1] !== undefined) return parseInt(urlMatch[1], 10);
    return parseInt(raw, 10);
  }
  const currentNum = parsePrNumber(currentPrNumber);
  const candidateRefs = allRefs.filter((n) => n !== currentNum);

  if (candidateRefs.length === 0) {
    return { isFixOfFix: false, recentlyMergedRefs: [], allRefs };
  }

  // Check each referenced PR's mergedAt in parallel.
  const checks = await Promise.all(
    candidateRefs.map(async (prNum) => {
      const mergedAt = await getPrMergedAt(prNum, execFn);
      if (!mergedAt) return null;
      return isMergedWithinDays(mergedAt, windowDays, now) ? prNum : null;
    }),
  );

  const recentlyMergedRefs = checks.filter((n): n is number => n !== null);

  if (recentlyMergedRefs.length === 0) {
    return { isFixOfFix: false, recentlyMergedRefs: [], allRefs };
  }

  // Label the current PR.
  await ensureFixOfFixLabel(execFn);
  await applyFixOfFixLabel(currentPrNumber, execFn);

  return { isFixOfFix: true, recentlyMergedRefs, allRefs };
}
