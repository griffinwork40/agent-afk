/**
 * Artifact recovery from session tool-event result previews.
 *
 * Recovers commit SHAs from `git commit` result previews and PR URLs from
 * `gh pr create` previews. The result field in stored session toolEvents
 * contains an ~90-char truncated preview of the actual output.
 *
 * Patterns (from real session data):
 *   git commit: "[branch sha] msg…"  or  "[branch (root-commit) sha] msg…"
 *   gh pr create: "https://github.com/<o>/<r>/pull/<n>"
 */

import type { Artifacts } from './schema.js';

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Matches: [branch sha] msg  or  [branch (root-commit) sha] msg
// Groups: sha (hex, 7-40 chars), repo-path hint (from cwd in the bash input)
const COMMIT_PATTERN =
  /^\[[\w/.\-]+(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]/m;

// Matches a full GitHub PR URL anywhere in the result preview
const PR_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/g;

// A result that is nothing but a PR URL (optionally after one gh warning line):
// the stdout shape of `gh pr create`.
const BARE_PR_URL_RESULT =
  /^\s*(?:Warning:[^\n]*\n)?\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\s*$/;

// Read-only gh queries that can also print a bare PR URL.
const PR_QUERY_INPUT = /gh\s+(?:pr|api|search)\s+(?:view|list|status|prs)|--json|\s-q\s|--jq/;

// ---------------------------------------------------------------------------
// ToolEvent input shape (minimal — not importing the whole facet schema)
// ---------------------------------------------------------------------------

export interface ToolEvent {
  toolName: string;
  input?: string;
  result?: string;
  isError?: boolean;
}

export interface Turn {
  user?: string;
  assistant?: string;
  toolEvents?: ToolEvent[];
}

// ---------------------------------------------------------------------------
// Recovery functions
// ---------------------------------------------------------------------------

/**
 * Extract commit SHAs from all tool events in a session.
 * Returns deduplicated SHAs in encounter order.
 */
export function recoverCommitSHAs(turns: Turn[]): string[] {
  const seen = new Set<string>();
  const shas: string[] = [];
  for (const turn of turns) {
    for (const ev of turn.toolEvents ?? []) {
      if (ev.isError === true) continue;
      const result = ev.result ?? '';
      const m = COMMIT_PATTERN.exec(result);
      if (m !== null && m[1] !== undefined) {
        const sha = m[1];
        if (!seen.has(sha)) {
          seen.add(sha);
          shas.push(sha);
        }
      }
    }
  }
  return shas;
}

/**
 * Contract: true only when this tool event most likely CREATED a PR.
 * Either the (possibly truncated) bash input names `gh pr create`, or the
 * input was truncated before the gh verb (stored inputs end in an ellipsis)
 * and the result is exactly a bare PR URL, the stdout shape of
 * `gh pr create`, and the visible input is not a read-only gh query.
 *
 * History: the first M0 cut scanned every tool result and all assistant text,
 * so any PR merely mentioned (gh pr view, PR lists, links in prose) was
 * attributed to the session, and pr_fate then scored other PRs' merges as
 * this session's success. On real data that inflated PR-bearing sessions from
 * ~143-216 to 457 of 1001.
 */
export function isPRCreateEvent(ev: ToolEvent): boolean {
  if (ev.toolName !== 'bash' || ev.isError === true) return false;
  const input = ev.input ?? '';
  if (/gh\s+pr\s+create/.test(input)) return true;
  const truncated = input.trimEnd().endsWith('\u2026');
  return truncated && BARE_PR_URL_RESULT.test(ev.result ?? '') && !PR_QUERY_INPUT.test(input);
}

/**
 * Extract URLs of PRs the session CREATED (see `isPRCreateEvent`).
 * Assistant prose and read-only gh output are deliberately ignored.
 * Returns deduplicated URLs in encounter order.
 */
export function recoverPRURLs(turns: Turn[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  function scanText(src: string): void {
    PR_URL_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PR_URL_PATTERN.exec(src)) !== null) {
      const url = m[0];
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }

  for (const turn of turns) {
    for (const ev of turn.toolEvents ?? []) {
      if (isPRCreateEvent(ev)) scanText(ev.result ?? '');
    }
  }
  return urls;
}

/**
 * Infer the primary git repo from bash tool inputs that contain a cwd-switch.
 * Returns the last non-afk-worktrees path that appears in a `cd ... && git`
 * command, or null if none found.
 */
export function inferRepo(turns: Turn[]): string | null {
  const CWD_PATTERN = /cd\s+([^\s&;]+).*git/;
  let last: string | null = null;
  for (const turn of turns) {
    for (const ev of turn.toolEvents ?? []) {
      if (ev.toolName !== 'bash') continue;
      const input = ev.input ?? '';
      const m = CWD_PATTERN.exec(input);
      if (m !== null && m[1] !== undefined) {
        last = m[1];
      }
    }
  }
  return last;
}

/**
 * Recover all artifacts from a session's turns.
 */
export function recoverArtifacts(turns: Turn[]): Artifacts {
  return {
    commits: recoverCommitSHAs(turns),
    prs: recoverPRURLs(turns),
    repo: inferRepo(turns),
  };
}
