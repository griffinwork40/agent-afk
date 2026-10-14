/**
 * Pure builders for `/bug`: turn a one-line description plus a small
 * environment block into a prefilled GitHub "new issue" URL.
 *
 * Contract: nothing here performs I/O. The handler (`bug.ts`) gathers the
 * environment and prints the result; these functions only shape strings, so
 * a later direct-filing path (`gh issue create`) or another surface can reuse
 * them in-process. Never shell out to `afk` to reach this logic: an unknown
 * subcommand launches a nested REPL (see AFK.md, "Critical Safety Rule").
 *
 * Invariant: the URL carries ONLY `title` and `body` query parameters.
 * GitHub returns 404 for the whole URL when the visitor lacks permission for
 * any parameter (e.g. `labels` needs triage rights), and almost every npm
 * user has read access only. `template` is omitted too, because its
 * precedence against `body` is undocumented and we must not lose the
 * environment block. The body mirrors `.github/ISSUE_TEMPLATE/bug_report.md`
 * by hand instead. Labelling is left to maintainer triage.
 *
 * Invariant: the user's description is passed through `redactSecrets` before
 * it reaches the URL, because a prefilled URL lands in browser history and
 * proxy logs before the user ever clicks Submit, and the issue is public.
 */

import { redactSecrets } from '../../../agent/redact-secrets.js';

/** Canonical public repo that receives `/bug` reports. */
export const BUG_REPORT_REPO = 'griffinwork40/agent-afk';

/**
 * Upper bound for the full URL. GitHub answers 414 (URI Too Long) past its
 * server limit; ~8 KB is the empirically safe ceiling other CLIs use, so we
 * stay under it with headroom.
 */
export const MAX_BUG_URL_LENGTH = 7500;

/** GitHub caps issue titles at 256 chars; keep ours short and scannable. */
const MAX_TITLE_LENGTH = 120;

const TRUNCATION_MARKER = '\n\n_(truncated by /bug to fit the URL limit)_';

export interface BugEnvironment {
  version: string;
  nodeVersion: string;
  /** e.g. "darwin 25.0.0 (arm64)". */
  os: string;
  model?: string;
  sessionId?: string;
}

export interface BugReport {
  title: string;
  body: string;
}

export interface BugReportLink {
  url: string;
  /** True when the description was shortened to fit {@link MAX_BUG_URL_LENGTH}. */
  truncated: boolean;
}

/** Title = first line of the (redacted) description, clipped. */
export function buildBugTitle(description: string): string {
  const firstLine = redactSecrets(description).trim().split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/** Body that mirrors the repo's bug_report.md sections. */
export function buildBugBody(description: string, env: BugEnvironment): string {
  const what = redactSecrets(description).trim() || '_Describe the bug._';
  const envLines = [
    `- \`agent-afk\` version: ${env.version}`,
    `- Node version: ${env.nodeVersion}`,
    `- OS: ${env.os}`,
    `- Model: ${env.model ?? 'unknown'}`,
  ];
  if (env.sessionId) envLines.push(`- Session id: ${env.sessionId}`);
  return [
    '<!-- Filed with /bug. This issue is PUBLIC: remove anything private before submitting. -->',
    '**What happened**',
    what,
    '',
    '**Expected behavior**',
    '_What you expected instead._',
    '',
    '**Repro steps**',
    '1. ',
    '',
    '**Environment**',
    ...envLines,
    '',
    '**Logs / trace**',
    '_Optional. Redact API keys and tokens._',
  ].join('\n');
}

export function buildBugReport(description: string, env: BugEnvironment): BugReport {
  return { title: buildBugTitle(description), body: buildBugBody(description, env) };
}

/** Prefilled `issues/new` URL; only `title` and `body` (see module Invariant). */
export function bugReportUrl(report: BugReport, repo: string = BUG_REPORT_REPO): string {
  const params = new URLSearchParams({ title: report.title, body: report.body });
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

/**
 * Build the link, shortening the description until the URL fits the limit.
 * Terminates: each pass removes at least 16 chars, and an empty description
 * yields a fixed-size body far below the limit.
 */
export function buildBugReportLink(
  description: string,
  env: BugEnvironment,
  maxLength: number = MAX_BUG_URL_LENGTH,
): BugReportLink {
  let url = bugReportUrl(buildBugReport(description, env));
  if (url.length <= maxLength) return { url, truncated: false };

  let desc = description;
  while (url.length > maxLength && desc.length > 0) {
    // Encoded length can exceed raw length (multi-byte, %XX), so cut by the
    // overflow but never by fewer than 16 chars to guarantee progress.
    const cut = Math.max(url.length - maxLength, 16);
    desc = desc.slice(0, Math.max(desc.length - cut, 0));
    const body = buildBugBody(desc + TRUNCATION_MARKER, env);
    url = bugReportUrl({ title: buildBugTitle(description), body });
  }
  return { url, truncated: true };
}
