/**
 * Tests for gh issue helpers. All exec is injected; no real `gh` runs.
 */

import { describe, it, expect, vi } from 'vitest';
import { canApplyLabels, createIssue, getGhLogin, getViewerPermission } from './gh.issue.js';
import { GhError } from './gh.js';

describe('canApplyLabels', () => {
  it('allows triage and above only', () => {
    expect(canApplyLabels('ADMIN')).toBe(true);
    expect(canApplyLabels('MAINTAIN')).toBe(true);
    expect(canApplyLabels('WRITE')).toBe(true);
    expect(canApplyLabels('TRIAGE')).toBe(true);
    expect(canApplyLabels('READ')).toBe(false);
    expect(canApplyLabels('NONE')).toBe(false);
  });
});

describe('getGhLogin', () => {
  it('returns the trimmed login', async () => {
    const exec = vi.fn(async () => ({ stdout: 'octocat\n', stderr: '' }));
    expect(await getGhLogin(exec)).toBe('octocat');
    expect(exec).toHaveBeenCalledWith('gh', ['api', 'user', '--jq', '.login']);
  });
  it('returns null on error or empty output', async () => {
    expect(await getGhLogin(vi.fn(async () => { throw new Error('x'); }))).toBeNull();
    expect(await getGhLogin(vi.fn(async () => ({ stdout: '  ', stderr: '' })))).toBeNull();
  });
});

describe('getViewerPermission', () => {
  it('parses a known permission', async () => {
    const exec = vi.fn(async () => ({ stdout: 'TRIAGE\n', stderr: '' }));
    expect(await getViewerPermission('o/r', exec)).toBe('TRIAGE');
    expect(exec).toHaveBeenCalledWith('gh', ['repo', 'view', 'o/r', '--json', 'viewerPermission', '--jq', '.viewerPermission']);
  });
  it('fails closed to READ on error or unknown values', async () => {
    expect(await getViewerPermission('o/r', vi.fn(async () => { throw new Error('x'); }))).toBe('READ');
    expect(await getViewerPermission('o/r', vi.fn(async () => ({ stdout: 'SUPERUSER', stderr: '' })))).toBe('READ');
  });
});

describe('createIssue', () => {
  it('sends the body on stdin via --body-file - and passes labels as separate args', async () => {
    const exec = vi.fn(async () => ({ stdout: 'https://github.com/o/r/issues/1\n', stderr: '' }));
    const body = 'has `backticks` and $(subshell) and "quotes"';
    const url = await createIssue({ repo: 'o/r', title: 'T', body, labels: ['bug'] }, exec);
    expect(url).toBe('https://github.com/o/r/issues/1');
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--repo', 'o/r', '--title', 'T', '--body-file', '-', '--label', 'bug'],
      body,
    );
  });
  it('omits --label when no labels are given', async () => {
    const exec = vi.fn(async () => ({ stdout: 'u', stderr: '' }));
    await createIssue({ repo: 'o/r', title: 'T', body: 'b' }, exec);
    const args = exec.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--label');
  });
  it('throws GhError on failure', async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 401: auth required', exitCode: 1 }); });
    await expect(createIssue({ repo: 'o/r', title: 'T', body: 'b' }, exec)).rejects.toBeInstanceOf(GhError);
    await expect(createIssue({ repo: 'o/r', title: 'T', body: 'b' }, exec)).rejects.toMatchObject({ kind: 'unauthed' });
  });
});
