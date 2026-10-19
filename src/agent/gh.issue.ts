/**
 * GitHub issue helpers over the `gh` CLI: who am I, what can I do on a repo,
 * and create an issue with the body fed through stdin.
 *
 * Sibling of `gh.ts` (shares its exec defaults and `GhError`); split out so
 * `gh.ts` stays under the file-size ceiling. All exec functions are
 * injectable so tests never spawn a real `gh`.
 *
 * Contract: `createIssue` passes the body via `--body-file -` on stdin and
 * every argument as a separate argv entry with no shell, so markdown
 * (backticks, `$()`, quotes) is never interpreted.
 */

import {
  GhError,
  defaultExecFn,
  defaultExecWithInput,
  type ExecFn,
  type ExecWithInputFn,
} from './gh.js';

export type ViewerPermission = 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ' | 'NONE';

const LABEL_CAPABLE: ReadonlySet<ViewerPermission> = new Set(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE']);

/** True when the viewer may apply labels (triage or above). */
export function canApplyLabels(permission: ViewerPermission): boolean {
  return LABEL_CAPABLE.has(permission);
}

/** Login of the authenticated `gh` account, or `null` when it cannot be read. */
export async function getGhLogin(execFn: ExecFn = defaultExecFn): Promise<string | null> {
  try {
    const { stdout } = await execFn('gh', ['api', 'user', '--jq', '.login']);
    const login = stdout.trim();
    return login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

/**
 * The viewer's permission on `repo` (`owner/name`). Fails closed to `'READ'`
 * on any error or unexpected value, so callers never over-claim rights.
 */
export async function getViewerPermission(
  repo: string,
  execFn: ExecFn = defaultExecFn,
): Promise<ViewerPermission> {
  try {
    const { stdout } = await execFn('gh', [
      'repo', 'view', repo, '--json', 'viewerPermission', '--jq', '.viewerPermission',
    ]);
    const value = stdout.trim().toUpperCase();
    const known: readonly ViewerPermission[] = ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', 'NONE'];
    return (known as readonly string[]).includes(value) ? (value as ViewerPermission) : 'READ';
  } catch {
    return 'READ';
  }
}

export interface CreateIssueOpts {
  repo: string;
  title: string;
  body: string;
  labels?: readonly string[];
}

/**
 * Reject malformed or unrelated output rather than printing it as a filed issue.
 * A HOST/OWNER/REPO target also pins the host; a bare OWNER/REPO may use GHE.
 */
export function validateIssueUrl(value: string, repo: string): string {
  const parts = repo.split('/');
  const expectedPath = `/${parts.slice(-2).join('/')}/issues/`;
  try {
    const url = new URL(value);
    if (!/^https:\/\/[^\s]+$/.test(value) || url.username || url.password || url.port
      || url.search || url.hash || !url.pathname.startsWith(expectedPath)
      || !/^[1-9]\d*$/.test(url.pathname.slice(expectedPath.length))
      || (parts.length === 3 && url.hostname !== parts[0])) throw new Error('invalid');
    return value;
  } catch {
    throw new Error('gh returned an invalid issue URL');
  }
}

/**
 * Create an issue via `gh issue create --body-file -`. Returns the issue URL
 * (trimmed, validated as HTTPS and matching the repo). Throws `GhError` on failure.
 */
export async function createIssue(
  opts: CreateIssueOpts,
  execFn: ExecWithInputFn = defaultExecWithInput,
): Promise<string> {
  const args = ['issue', 'create', '--repo', opts.repo, '--title', opts.title, '--body-file', '-'];
  for (const label of opts.labels ?? []) args.push('--label', label);
  try {
    const { stdout } = await execFn('gh', args, opts.body);
    return validateIssueUrl(stdout.trim(), opts.repo);
  } catch (err: unknown) {
    const e = err as { stderr?: string; exitCode?: number; code?: string; killed?: boolean };
    const stderr = e.stderr ?? '';
    const kind = e.killed ? 'timeout' : e.code === 'ENOENT' ? 'not-found' : /auth/i.test(stderr) ? 'unauthed' : 'unknown';
    // When stderr is empty the process may have exited cleanly but stdout failed
    // validation (e.g. validateIssueUrl threw). Preserve the original Error
    // message so callers see "gh issue create failed (unknown): invalid issue URL"
    // instead of the useless "gh issue create failed (unknown): ".
    // GhError.stderr stays raw (the original stderr bytes) while `message`
    // uses the enriched `detail` string — which falls back to err.message when
    // stderr is empty (e.g. "invalid issue URL" from validateIssueUrl).
    const detail = stderr.trim() || (err instanceof Error ? err.message : '');
    throw new GhError(`gh issue create failed (${kind}): ${detail}`, kind, e.exitCode ?? 1, stderr);
  }
}
