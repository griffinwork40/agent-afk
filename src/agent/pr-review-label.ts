/**
 * PR review coverage labeling — issue #2011.
 *
 * At merge time (ship / review auto-merge offer) every PR gets exactly one
 * of three labels reflecting how it was reviewed before merging:
 *
 *   human-reviewed  — at least one approval from a non-bot account
 *   agent-reviewed  — only bot/agent approvals (no human approval)
 *   auto-merged     — merged via the /review auto-merge offer (docs/test-only)
 *
 * These labels make review coverage retrospectively queryable:
 *
 *   gh issue list --label human-reviewed
 *   gh issue list --label agent-reviewed
 *
 * And a weekly metric is derivable from label counts.
 *
 * Bot accounts excluded from "human" classification (exact login match):
 *   chatgpt-codex-connector, vercel[bot], dependabot[bot], github-actions[bot]
 * Any login ending in `[bot]` is also treated as a bot.
 *
 * @module agent/pr-review-label
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecFn } from './gh.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Label applied when at least one human (non-bot) approved the PR. */
export const LABEL_HUMAN_REVIEWED = 'human-reviewed';

/** Label applied when only bot/agent accounts approved (no human approval). */
export const LABEL_AGENT_REVIEWED = 'agent-reviewed';

/** Label applied when the PR was merged via the /review auto-merge offer. */
export const LABEL_AUTO_MERGED = 'auto-merged';

/** All three possible review-coverage labels, for idempotent cleanup. */
export const ALL_REVIEW_LABELS = [
  LABEL_HUMAN_REVIEWED,
  LABEL_AGENT_REVIEWED,
  LABEL_AUTO_MERGED,
] as const;

export type ReviewLabel = (typeof ALL_REVIEW_LABELS)[number];

/** Hard-coded bot login list (issue #2011). Logins ending in `[bot]` are also excluded. */
export const BOT_LOGINS: ReadonlySet<string> = new Set([
  'chatgpt-codex-connector',
  'vercel[bot]',
  'dependabot[bot]',
  'github-actions[bot]',
]);

/** Timeout for each `gh` invocation. */
const EXEC_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of one review entry returned by `gh pr view --json reviews`. */
export interface PrReview {
  author: { login: string };
  state: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
  submittedAt: string;
}

/** Result of classifying a PR's review list. */
export type ReviewClassification =
  | { label: typeof LABEL_HUMAN_REVIEWED; humanLogins: string[] }
  | { label: typeof LABEL_AGENT_REVIEWED; botLogins: string[] }
  | { label: typeof LABEL_AUTO_MERGED };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultExecFn(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    timeout: EXEC_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  }).then((r) => ({ stdout: r.stdout, stderr: r.stderr }));
}

/**
 * Returns true when the given GitHub login should be treated as a bot.
 * Matches the hard-coded set or any login that ends with `[bot]`.
 */
export function isBotLogin(login: string): boolean {
  if (BOT_LOGINS.has(login)) return true;
  // GitHub bot accounts conventionally end with `[bot]`
  if (login.endsWith('[bot]')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Core classification logic
// ---------------------------------------------------------------------------

/**
 * Classify a list of PR reviews as human-reviewed, agent-reviewed, or (when
 * `autoMerged` is true) auto-merged. The classification is:
 *
 * - `auto-merged`      if `autoMerged === true` (caller passes this from context)
 * - `human-reviewed`   if at least one APPROVED review is from a non-bot login
 * - `agent-reviewed`   otherwise (zero APPROVED reviews, or all approvers are bots)
 */
export function classifyReviews(
  reviews: PrReview[],
  autoMerged = false,
): ReviewClassification {
  if (autoMerged) {
    return { label: LABEL_AUTO_MERGED };
  }

  const approvals = reviews.filter((r) => r.state === 'APPROVED');
  const humanApprovals = approvals.filter((r) => !isBotLogin(r.author.login));

  if (humanApprovals.length > 0) {
    return {
      label: LABEL_HUMAN_REVIEWED,
      humanLogins: humanApprovals.map((r) => r.author.login),
    };
  }

  return {
    label: LABEL_AGENT_REVIEWED,
    botLogins: approvals.map((r) => r.author.login),
  };
}

// ---------------------------------------------------------------------------
// GitHub API calls
// ---------------------------------------------------------------------------

/**
 * Fetch the reviews for a PR via `gh pr view <n> --json reviews`.
 * Returns an empty array on failure (fail-soft — labeling should never block a merge).
 */
export async function fetchPrReviews(pr: string, execFn?: ExecFn): Promise<PrReview[]> {
  const exec = execFn ?? defaultExecFn;
  try {
    const { stdout } = await exec('gh', ['pr', 'view', pr, '--json', 'reviews', '--jq', '.reviews']);
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed)) return [];
    // Validate shape; drop malformed entries
    return (parsed as PrReview[]).filter(
      (r) =>
        r &&
        typeof r === 'object' &&
        r.author &&
        typeof r.author.login === 'string' &&
        typeof r.state === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Ensure a label exists on the repository. Creates it via `gh label create`
 * if it does not exist yet. Color and description are set on creation; a
 * pre-existing label with a different color is NOT overwritten (idempotent).
 *
 * Colors:
 *   human-reviewed  #0075ca (blue)
 *   agent-reviewed  #e4e669 (yellow)
 *   auto-merged     #cfd3d7 (silver/grey)
 */
export async function ensureLabelExists(
  label: ReviewLabel,
  execFn?: ExecFn,
): Promise<void> {
  const exec = execFn ?? defaultExecFn;

  const meta: Record<ReviewLabel, { color: string; description: string }> = {
    [LABEL_HUMAN_REVIEWED]: {
      color: '0075ca',
      description: 'PR had at least one human approval before merge',
    },
    [LABEL_AGENT_REVIEWED]: {
      color: 'e4e669',
      description: 'PR was approved only by bot/agent accounts before merge',
    },
    [LABEL_AUTO_MERGED]: {
      color: 'cfd3d7',
      description: 'PR merged via /review auto-merge offer (docs/test-only)',
    },
  };

  const { color, description } = meta[label];

  try {
    // Try to create — gh label create errors (exit 1) when label already exists.
    // We swallow that error to make this idempotent.
    await exec('gh', [
      'label',
      'create',
      label,
      '--color',
      color,
      '--description',
      description,
      '--force', // update if exists (idempotent)
    ]);
  } catch {
    // Label creation failed (e.g. auth failure, network) — non-fatal.
    // The caller should still attempt to apply the label.
  }
}

/**
 * Apply a review-coverage label to a PR (and remove any stale sibling labels
 * so the PR always has exactly one of the three). Fail-soft — never throws.
 *
 * Steps:
 *   1. Ensure the target label exists on the repo (create if needed).
 *   2. Remove sibling review-coverage labels that are already present.
 *   3. Apply the new label.
 */
export async function applyReviewLabel(
  pr: string,
  label: ReviewLabel,
  execFn?: ExecFn,
): Promise<void> {
  const exec = execFn ?? defaultExecFn;

  // Step 1 — ensure the label exists in the repo.
  await ensureLabelExists(label, execFn);

  // Step 2 — remove stale sibling labels.
  const siblings = ALL_REVIEW_LABELS.filter((l) => l !== label);
  for (const sibling of siblings) {
    try {
      await exec('gh', ['pr', 'edit', pr, '--remove-label', sibling]);
    } catch {
      // Label may not exist on this PR — ignore.
    }
  }

  // Step 3 — apply the target label.
  try {
    await exec('gh', ['pr', 'edit', pr, '--add-label', label]);
  } catch {
    // Non-fatal — merge already happened; labeling is best-effort.
  }
}

/**
 * High-level entry point: fetch the PR's reviews, classify, and apply the
 * appropriate review-coverage label. Pass `autoMerged: true` when the call
 * comes from the /review auto-merge path.
 *
 * Fail-soft — never throws. Suitable for fire-and-forget after a merge.
 */
export async function labelPrReviewCoverage(
  pr: string,
  opts: { autoMerged?: boolean; execFn?: ExecFn } = {},
): Promise<ReviewLabel> {
  const { autoMerged = false, execFn } = opts;

  const reviews = autoMerged ? [] : await fetchPrReviews(pr, execFn);
  const classification = classifyReviews(reviews, autoMerged);
  await applyReviewLabel(pr, classification.label, execFn);
  return classification.label;
}
