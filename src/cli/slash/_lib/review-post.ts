/**
 * `/review --post` publishing layer.
 *
 * Keeps the `review` skill itself read-only — its SKILL.md forbids any PR
 * mutation (`gh pr comment`/`edit`/`merge`). The `--post` flag is parsed at the
 * slash-dispatch layer; after the skill emits its final verified review, the
 * captured output is published here as a deterministic, fail-soft side effect:
 *
 *   - github   → the full review markdown as a PR comment (`gh pr comment
 *                --body-file -`), tagged with the `<!-- agent-afk-review -->`
 *                marker so a future version can find-and-edit instead of append.
 *   - telegram → a concise summary (decision + top findings), chunked to
 *                Telegram's 4096-char per-message limit.
 *
 * Invariant: publishing NEVER throws and NEVER suppresses stdout. The review is
 * already streamed to the terminal by the renderer before this runs; a failed
 * post is reported via the writer and the review output stands untouched.
 *
 * Auth note: the review runs on the session's Claude credential; posting uses
 * entirely separate, independently-configured auth — `gh`'s own login for
 * github, and `TELEGRAM_BOT_TOKEN` for telegram. No credential is shared.
 *
 * @module cli/slash/_lib/review-post
 */

import type { Writer } from '../types.js';
import {
  checkGhReady,
  postPrComment,
  resolveCurrentBranchPr,
} from '../../../agent/gh.js';
import { pushIfConfigured } from '../../../telegram/push.js';

export type PostTarget = 'github' | 'telegram';

/** Telegram hard per-message limit. */
const TELEGRAM_LIMIT = 4096;
/** Marker embedded at the top of every posted GitHub comment. */
export const REVIEW_MARKER = '<!-- agent-afk-review -->';

const VALID_TARGETS: ReadonlySet<string> = new Set(['github', 'telegram']);
// Matches `--post github`, `--post=github`, and `--post github,telegram`.
const POST_FLAG_RE = /--post(?:=|\s+)([^\s]+)/g;

export interface ParsedPostFlag {
  /** Recognized targets, deduped, in encounter order. */
  targets: PostTarget[];
  /** Args with every `--post …` token (and any bare `--post`) removed. */
  cleanedArgs: string;
  /** Unrecognized target tokens, for the caller to warn about. */
  unknown: string[];
}

/**
 * Extract `--post <targets>` from a `/review` arg string. Supports
 * `--post github`, `--post=telegram`, comma lists (`--post github,telegram`),
 * and repeated flags. Leaves all other review args (`--staged`, a PR ref, …)
 * intact in `cleanedArgs`.
 */
export function parsePostFlag(args: string): ParsedPostFlag {
  // Verbatim passthrough when `--post` is absent: the preflight's rawArgs
  // contract requires the review target string to reach the skill untouched
  // (no trim/collapse). Only normalize whitespace when we actually remove a
  // `--post …` token.
  if (!/--post\b/.test(args)) {
    return { targets: [], cleanedArgs: args, unknown: [] };
  }

  const targets: PostTarget[] = [];
  const unknown: string[] = [];

  for (const m of args.matchAll(POST_FLAG_RE)) {
    const raw = m[1] ?? '';
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (VALID_TARGETS.has(part)) {
        const t = part as PostTarget;
        if (!targets.includes(t)) targets.push(t);
      } else {
        unknown.push(part);
      }
    }
  }

  const cleanedArgs = args
    .replace(POST_FLAG_RE, ' ')
    // Strip a dangling bare `--post` with no value.
    .replace(/(^|\s)--post(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { targets, cleanedArgs, unknown };
}

/**
 * Split text into chunks no longer than `limit`, preferring line boundaries.
 * A single line longer than `limit` is hard-split. Pure — page markers are the
 * caller's job. Returns `[text]` unchanged when it already fits.
 */
export function chunkText(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text];
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (cur.length + line.length + 1 > limit) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Build the GitHub PR comment body: the marker line, the full review markdown,
 * and a small provenance footer. The marker lets a future version find and edit
 * the prior agent-afk comment instead of appending a new one.
 */
export function buildGithubBody(review: string): string {
  return (
    `${REVIEW_MARKER}\n\n${review.trim()}\n\n` +
    '---\n_🤖 Posted by `agent-afk /review --post github`_'
  );
}

/**
 * Derive a concise Telegram summary from the full review markdown: the merge
 * decision plus up to a handful of high-signal finding lines. Heuristic by
 * design — the full review lives in the terminal and (when `--post github`) on
 * the PR; this is the at-a-glance push. Plain text (no markdown), since the
 * push is sent without a parse mode.
 */
export function summarizeForTelegram(review: string): string {
  const text = review.trim();
  const decision = /do not merge/i.test(text)
    ? '🔴 DO NOT MERGE'
    : /\bmerge\b/i.test(text)
      ? '🟢 MERGE'
      : 'ℹ️ Review complete';

  // High-signal lines: a file:line citation paired with a severity word, or a
  // markdown bullet/heading carrying a severity word. Capped to stay short.
  const findingLines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const hasCitation = /[\w./-]+:\d+/.test(line);
    const hasSeverity = /\b(critical|high|blocking|medium)\b/i.test(line);
    const isBullet = /^([-*]\s|#{1,6}\s)/.test(line);
    if ((hasCitation && hasSeverity) || (isBullet && hasSeverity)) {
      findingLines.push(line.replace(/^([-*]+|#{1,6})\s*/, '• '));
    }
    if (findingLines.length >= 8) break;
  }

  const parts = [`agent-afk review — ${decision}`];
  if (findingLines.length > 0) parts.push('', ...findingLines);
  parts.push('', 'Full review in terminal / on the PR.');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestrator (side-effecting, fail-soft)
// ---------------------------------------------------------------------------

export interface ReviewPostDeps {
  checkGhReady: typeof checkGhReady;
  postPrComment: typeof postPrComment;
  resolveCurrentBranchPr: typeof resolveCurrentBranchPr;
  pushIfConfigured: typeof pushIfConfigured;
}

const DEFAULT_DEPS: ReviewPostDeps = {
  checkGhReady,
  postPrComment,
  resolveCurrentBranchPr,
  pushIfConfigured,
};

export interface RunReviewPostParams {
  targets: PostTarget[];
  reviewText: string;
  /** PR ref parsed from the review args (null when the target was local). */
  prRefFromArgs: string | null;
}

/**
 * Publish a completed review to the requested targets. Fail-soft: every target
 * is attempted independently, all errors are reported via `out` and swallowed,
 * and a missing/empty review is reported rather than thrown.
 */
export async function runReviewPostPublish(
  out: Writer,
  params: RunReviewPostParams,
  deps: Partial<ReviewPostDeps> = {},
): Promise<void> {
  const d: ReviewPostDeps = { ...DEFAULT_DEPS, ...deps };
  const review = (params.reviewText ?? '').trim();
  if (!review) {
    out.warn('/review --post: no review output was captured — nothing to post.');
    return;
  }
  for (const target of params.targets) {
    if (target === 'github') {
      await publishGithub(out, review, params.prRefFromArgs, d);
    } else {
      await publishTelegram(out, review, d);
    }
  }
}

async function publishGithub(
  out: Writer,
  review: string,
  prRefFromArgs: string | null,
  d: ReviewPostDeps,
): Promise<void> {
  try {
    const ready = await d.checkGhReady();
    if (!ready.ok) {
      out.warn(`/review --post github skipped: ${ready.hint}`);
      return;
    }
    let pr = (prRefFromArgs ?? '').trim();
    if (!pr) {
      const resolved = await d.resolveCurrentBranchPr();
      if (!resolved) {
        out.warn(
          '/review --post github skipped: no PR to comment on. The review target was not a ' +
            'PR and the current branch has no open PR. Re-run with a PR number/URL, or open a PR first.',
        );
        return;
      }
      pr = resolved;
    }
    const url = await d.postPrComment({ pr, body: buildGithubBody(review) });
    out.success(`/review posted to GitHub PR #${pr}${url ? ` — ${url}` : ''}`);
  } catch (err) {
    out.warn(
      `/review --post github failed: ${err instanceof Error ? err.message : String(err)} ` +
        '(the review output above is unaffected).',
    );
  }
}

async function publishTelegram(out: Writer, review: string, d: ReviewPostDeps): Promise<void> {
  try {
    const summary = summarizeForTelegram(review);
    // Reserve room for an "(i/n)\n" page marker so prefixed chunks stay ≤ limit.
    const PAGE_PREFIX_BUDGET = 12;
    const chunks = chunkText(summary, TELEGRAM_LIMIT - PAGE_PREFIX_BUDGET);
    const paged =
      chunks.length > 1 ? chunks.map((c, i) => `(${i + 1}/${chunks.length})\n${c}`) : chunks;

    let anySent = false;
    for (const chunk of paged) {
      const results = await d.pushIfConfigured(chunk);
      if (results === null) {
        out.warn(
          '/review --post telegram skipped: Telegram is not configured ' +
            '(TELEGRAM_BOT_TOKEN / AFK_TELEGRAM_ALLOWED_CHAT_IDS).',
        );
        return;
      }
      if (results.some((r) => r.ok)) anySent = true;
    }
    if (anySent) {
      out.success(
        `/review summary sent to Telegram${paged.length > 1 ? ` (${paged.length} messages)` : ''}.`,
      );
    } else {
      out.warn('/review --post telegram failed: Telegram rejected all sends.');
    }
  } catch (err) {
    out.warn(
      `/review --post telegram failed: ${err instanceof Error ? err.message : String(err)} ` +
        '(the review output above is unaffected).',
    );
  }
}
