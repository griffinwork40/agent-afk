import { describe, expect, it } from 'vitest';
import { formatCwd } from './format-cwd.js';

const HOME = '/Users/jane';

describe('formatCwd', () => {
  it('returns empty string for empty input', () => {
    expect(formatCwd('', { homedir: HOME })).toBe('');
  });

  it('tildifies the homedir itself', () => {
    expect(formatCwd(HOME, { homedir: HOME })).toBe('~');
  });

  it('tildifies paths under homedir', () => {
    expect(formatCwd('/Users/jane/Projects/foo', { homedir: HOME })).toBe(
      '~/Projects/foo',
    );
  });

  it('leaves paths outside homedir unchanged', () => {
    expect(formatCwd('/tmp/foo', { homedir: HOME })).toBe('/tmp/foo');
  });

  it('does not tildify sibling dirs that share a prefix', () => {
    // `/Users/janeway` must not become `~way`.
    expect(formatCwd('/Users/janeway/x', { homedir: HOME })).toBe(
      '/Users/janeway/x',
    );
  });

  it('returns the tildified path untouched when it fits the budget', () => {
    expect(
      formatCwd('/Users/jane/Projects/foo', { homedir: HOME, maxWidth: 40 }),
    ).toBe('~/Projects/foo');
  });

  it('collapses interior segments to `…` when the path is too wide', () => {
    const cwd = '/Users/jane/Projects/foo/.afk-worktrees/afk-2026-bar';
    const out = formatCwd(cwd, { homedir: HOME, maxWidth: 25 });
    // Must preserve the leaf segment.
    expect(out.endsWith('/afk-2026-bar')).toBe(true);
    // Must contain the ellipsis sentinel.
    expect(out).toContain('…');
    // Must fit the budget.
    expect(out.length).toBeLessThanOrEqual(25);
    // Should start with `~` since cwd is under homedir.
    expect(out.startsWith('~')).toBe(true);
  });

  it('falls back to `~/…/<leaf>` when the budget is very tight', () => {
    const cwd = '/Users/jane/Projects/foo/bar/baz/deep/leaf';
    const out = formatCwd(cwd, { homedir: HOME, maxWidth: 12 });
    expect(out).toContain('leaf');
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it('hard-truncates when even `~/…/<leaf>` exceeds the budget', () => {
    const cwd = '/Users/jane/very-long-leaf-segment-name';
    const out = formatCwd(cwd, { homedir: HOME, maxWidth: 6 });
    // Must not exceed the budget.
    expect(out.length).toBeLessThanOrEqual(6);
    // The hard-truncate path uses the standard `…` sentinel.
    expect(out).toContain('…');
  });

  it('never emits a doubled-tilde when collapsing a homedir-rooted path', () => {
    // Regression: an earlier draft produced `~/~/…/<leaf>` because the
    // tildified `~` was being re-included as an interior segment.
    const cwd = '/Users/jane/Projects/agent-workspace/agent-afk/.afk-worktrees/afk-20260518-065201-7c6630';
    const out = formatCwd(cwd, { homedir: HOME, maxWidth: 36 });
    expect(out).not.toContain('~/~');
    expect(out.startsWith('~/')).toBe(true);
    expect(out.endsWith('/afk-20260518-065201-7c6630')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(36);
  });

  it('preserves single-segment outside-home paths up to a tilde-less truncate', () => {
    const out = formatCwd('/usr/local/var/some/deep/path', {
      homedir: HOME,
      maxWidth: 15,
    });
    expect(out.length).toBeLessThanOrEqual(15);
  });
});
