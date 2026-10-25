/**
 * Tests for gh issue helpers. All exec is injected; no real `gh` runs.
 */

import { describe, it, expect, vi } from 'vitest';
import { canApplyLabels, createIssue, getGhLogin, getViewerPermission, validateIssueUrl } from './gh.issue.js';
import { GhError, type ExecWithInputFn } from './gh.js';

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

describe('validateIssueUrl', () => {
  it.each([
    '', 'not a url', 'javascript:alert(1)', 'http://github.com/o/r/issues/1',
    'https://evil.example/o/r/issues/1', 'https://github.com/other/repo/issues/1',
    'https://github.com/o/r/issues/nope', 'https://github.com/o/r/issues/0',
    'https://github.com/o/r/issues/1\nextra',
    'https://user:pass@github.com/o/r/issues/1', 'https://github.com/o/r/issues/1?x=1',
    'https://github.com/o/r/issues/1#fragment',
    'https://github.com:8443/o/r/issues/1',
  ])('rejects invalid/unexpected output %j', (value) => {
    expect(() => validateIssueUrl(value, 'github.com/o/r')).toThrow('invalid issue URL');
  });
  it('allows a GHE host for a bare repo, but enforces explicitly qualified hosts', () => {
    expect(validateIssueUrl('https://ghe.example/o/r/issues/1', 'o/r')).toBe('https://ghe.example/o/r/issues/1');
    expect(() => validateIssueUrl('https://ghe.example/o/r/issues/1', 'github.com/o/r')).toThrow();
  });
  it('accepts an HTTPS issue URL for the target repository', () => {
    expect(validateIssueUrl('https://github.com/o/r/issues/123', 'github.com/o/r'))
      .toBe('https://github.com/o/r/issues/123');
  });
});

describe('createIssue', () => {
  it('rejects non-URL stdout', async () => {
    const exec = vi.fn(async () => ({ stdout: 'success!', stderr: '' }));
    const err = await createIssue({ repo: 'o/r', title: 'T', body: 'b' }, exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).message).toContain('invalid issue URL');
  });
  it('sends the body on stdin via --body-file - and passes labels as separate args', async () => {
    const exec = vi.fn(async () => ({ stdout: 'https://github.com/o/r/issues/1\n', stderr: '' }));
    const body = 'has `backticks` and $(subshell) and "quotes"';
    const url = await createIssue({ repo: 'o/r', title: 'T', body, labels: ['bug', 'needs triage'] }, exec);
    expect(url).toBe('https://github.com/o/r/issues/1');
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--repo', 'o/r', '--title', 'T', '--body-file', '-', '--label', 'bug', '--label', 'needs triage'],
      body,
    );
  });
  it('omits --label when no labels are given', async () => {
    const exec = vi.fn<ExecWithInputFn>(async () => ({ stdout: 'https://github.com/o/r/issues/1', stderr: '' }));
    await createIssue({ repo: 'o/r', title: 'T', body: 'b' }, exec);
    const args = exec.mock.calls[0]![1];
    expect(args).not.toContain('--label');
  });
  it('throws GhError on failure', async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 401: auth required', exitCode: 1 }); });
    await expect(createIssue({ repo: 'o/r', title: 'T', body: 'b' }, exec)).rejects.toBeInstanceOf(GhError);
    await expect(createIssue({ repo: 'o/r', title: 'T', body: 'b' }, exec)).rejects.toMatchObject({ kind: 'unauthed' });
  });
});
