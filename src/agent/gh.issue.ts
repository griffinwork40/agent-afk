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
 * Create an issue via `gh issue create --body-file -`. Returns the issue URL
 * (trimmed). Throws `GhError` on failure.
 */
export async function createIssue(
  opts: CreateIssueOpts,
  execFn: ExecWithInputFn = defaultExecWithInput,
): Promise<string> {
  const args = ['issue', 'create', '--repo', opts.repo, '--title', opts.title, '--body-file', '-'];
  for (const label of opts.labels ?? []) args.push('--label', label);
  try {
    const { stdout } = await execFn('gh', args, opts.body);
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; exitCode?: number; code?: string; killed?: boolean };
    const stderr = e.stderr ?? '';
    const kind = e.killed ? 'timeout' : e.code === 'ENOENT' ? 'not-found' : /auth/i.test(stderr) ? 'unauthed' : 'unknown';
    throw new GhError(`gh issue create failed (${kind}): ${stderr.trim()}`, kind, e.exitCode ?? 1, stderr);
  }
}
