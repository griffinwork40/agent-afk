/**
 * `/bug --file <description>`: file the bug report directly with
 * `gh issue create` after an explicit on-screen confirmation.
 *
 * Invariant: nothing reaches GitHub before the user presses Enter on a
 * preview that shows the title, labels, target repo, and the
 * `gh` account it will post as, plus a height-capped body excerpt with an
 * explicit omitted-line count. The preview needs the interactive REPL's
 * compositor; without one (Telegram, daemon, piped stdin) we fail closed and
 * fall back to the v1 prefilled link instead of filing unconfirmed.
 *
 * Invariant: every failure path (gh missing/unauthed, account unreadable,
 * create error) falls back to the prefilled link, so the user always leaves
 * with a way to report the bug.
 *
 * Labels: `--label bug` is passed only when the account has triage rights
 * or better on the repo; read-only accounts (most npm users) get no label
 * rather than a dropped or rejected one. Unknown permission fails closed to
 * read-only.
 */

import { palette } from '../../palette.js';
import { checkGhReady, defaultExecFn, type GhReadiness, type ExecFn } from '../../../agent/gh.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { hardWrapToWidth } from '../../wrap.js';
import { truncateDisplayWidth } from '../../display.js';
import {
  canApplyLabels,
  createIssue,
  getGhLogin,
  getViewerPermission,
  validateIssueUrl,
  type CreateIssueOpts,
  type ViewerPermission,
} from '../../../agent/gh.issue.js';
import { errorMessage } from '../../../utils/errors.js';
import { BUG_REPORT_REPO, buildBugReport, type BugEnvironment, type BugReport } from './bug.body.js';
import type { SlashContext, SlashResult } from '../types.js';
import type { PickerController, TerminalCompositor } from '../../terminal-compositor.js';

/** Injectable side effects (tests replace all of them). */
export interface BugFileDeps {
  checkGhReady: () => Promise<GhReadiness>;
  getGhLogin: () => Promise<string | null>;
  getViewerPermission: (repo: string) => Promise<ViewerPermission>;
  createIssue: (opts: CreateIssueOpts) => Promise<string>;
}

const BUG_FILE_REPO = `github.com/${BUG_REPORT_REPO}`;

/** Explicit CLI flags override GH_HOST without touching the spawn environment. */
const githubExec: ExecFn = (file, args) => defaultExecFn(file, [...args, '--hostname', 'github.com']);

export const defaultBugFileDeps: BugFileDeps = {
  // Bypass the ambient-host cache: a GHE readiness result says nothing about github.com.
  checkGhReady: () => checkGhReady({ hostname: 'github.com' }),
  getGhLogin: () => getGhLogin(githubExec),
  getViewerPermission: (repo) => getViewerPermission(repo),
  createIssue: (opts) => createIssue(opts),
};

/** Rows for the confirmation preview. Exported for tests. */
export function buildFilePreviewRows(
  report: BugReport,
  login: string,
  labels: readonly string[],
  repo: string = BUG_FILE_REPO,
  maxRows: number = Number.POSITIVE_INFINITY,
  columns: number = getTerminalWidth(),
): string[] {
  const width = Math.max(1, columns - 1);
  const footer = truncateDisplayWidth(palette.dim('Enter: file it   Esc: cancel'), width);
  const rows = [
    palette.warning(`File this as a PUBLIC issue on ${repo} as @${login}?`),
    '',
    `${palette.dim('Title: ')}${report.title}`,
    `${palette.dim('Labels:')} ${labels.length > 0 ? labels.join(', ') : 'none (triage will label it)'}`,
    '',
    ...report.body.split('\n'),
    '',
  ].flatMap((row) => hardWrapToWidth(row, width).split('\n'));
  rows.push(footer);
  const budget = Math.max(1, Math.floor(maxRows));
  if (rows.length <= budget) return rows;
  // Keep the confirmation controls visible, even in a very short viewport.
  if (budget === 1) return [footer];
  const visible = Math.max(0, budget - 2);
  const omitted = rows.length - visible - 1;
  return [...rows.slice(0, visible),
    truncateDisplayWidth(palette.dim(`${omitted} more lines (preview truncated)`), width), footer];
}

/** Show the preview; resolves true on Enter, false on Esc / Ctrl+C. */
export function confirmFiling(compositor: TerminalCompositor, rows: () => readonly string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      compositor.exitPickerMode();
      resolve(ok);
    };
    const controller: PickerController = {
      renderRows: rows,
      onKey: (_char, key): void => {
        if (key.name === 'return') finish(true);
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) finish(false);
      },
    };
    compositor.enterPickerMode(controller);
  });
}

/**
 * Run the `--file` flow. `fallback` prints the v1 prefilled link and is used
 * on every path that cannot file safely.
 */
export async function fileBugViaGh(
  ctx: SlashContext,
  description: string,
  env: BugEnvironment,
  fallback: () => SlashResult,
  deps: BugFileDeps = defaultBugFileDeps,
): Promise<SlashResult> {
  if (!description) {
    ctx.out.warn('Usage: /bug --file <what went wrong>  (a description is needed for the issue title)');
    return 'continue';
  }
  const compositor = ctx.getCompositor?.() ?? null;
  if (!compositor) {
    ctx.out.warn('--file needs the interactive REPL to confirm before filing. Use this link instead:');
    return fallback();
  }
  const ready = await deps.checkGhReady();
  if (!ready.ok) {
    ctx.out.warn(`Cannot file with gh: ${ready.hint}. Use this link instead:`);
    return fallback();
  }
  const login = await deps.getGhLogin();
  if (!login) {
    ctx.out.warn('Could not read your GitHub account from gh. Use this link instead:');
    return fallback();
  }
  const labels = canApplyLabels(await deps.getViewerPermission(BUG_FILE_REPO)) ? ['bug'] : [];
  const report = buildBugReport(description, env);

  const confirmed = await confirmFiling(compositor, () => buildFilePreviewRows(
    report, login, labels, BUG_FILE_REPO,
    // Leave room for the compositor's guard row, gap, and background status rows.
    Math.max(1, compositor.terminalRows() - 4),
  ));
  if (!confirmed) {
    ctx.out.info('Cancelled. Nothing was filed.');
    return 'continue';
  }
  try {
    const url = validateIssueUrl(await deps.createIssue({
      repo: BUG_FILE_REPO, title: report.title, body: report.body, labels,
    }), BUG_FILE_REPO);
    ctx.out.success(`${palette.success('Filed:')} ${url}`);
    return 'continue';
  } catch (err) {
    ctx.out.error(`Filing failed: ${errorMessage(err)}. Use this link instead:`);
    return fallback();
  }
}
