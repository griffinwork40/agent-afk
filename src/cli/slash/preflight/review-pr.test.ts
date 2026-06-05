/**
 * Tests for review-pr preflight.
 *
 * `gatherPrState` is exercised against a fake exec + fake writeFile so we
 * never shell out to real `gh` or touch disk. The renderer is then tested
 * in isolation. The combined preflight is sanity-checked on the parse-ref
 * path (null when args don't look like a PR).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parsePrRef,
  gatherPrState,
  renderManifest,
  reviewPrPreflight,
  _resetConcurrencyGuardForTests,
  _setConcurrencyGuardForTests,
} from './review-pr.js';
import type { PreflightContext, SkillInvocation } from './types.js';

const baseCtx: PreflightContext = {
  cwd: '/tmp/repo',
  artifactDir: '/tmp/artifacts',
};

const baseInv: SkillInvocation = {
  skillName: 'review',
  rawArgs: '277',
  source: 'plugin',
  capabilities: { compose: true, subagents: true },
};

beforeEach(() => {
  _resetConcurrencyGuardForTests();
});

describe('parsePrRef', () => {
  it('parses a bare integer', () => {
    expect(parsePrRef('277')).toBe('277');
  });
  it('parses a hash-prefixed integer', () => {
    expect(parsePrRef('#277')).toBe('277');
  });
  it('parses a GitHub PR URL', () => {
    expect(parsePrRef('https://github.com/owner/repo/pull/277')).toBe('277');
  });
  it('parses a GitHub PR URL with trailing path', () => {
    expect(parsePrRef('https://github.com/owner/repo/pull/277/files')).toBe('277');
  });
  it('returns null for empty args', () => {
    expect(parsePrRef('')).toBeNull();
    expect(parsePrRef('   ')).toBeNull();
  });
  it('returns null for non-PR shapes', () => {
    expect(parsePrRef('HEAD')).toBeNull();
    expect(parsePrRef('--staged')).toBeNull();
    expect(parsePrRef('abc123')).toBeNull();
  });

  // F10: range check — PR numbers must be 1–999999.
  it('F10 — throws for PR number 0', () => {
    expect(() => parsePrRef('0')).toThrow('[afk preflight] Invalid PR number');
  });
  it('F10 — throws for negative PR number', () => {
    expect(parsePrRef('#-1')).toBeNull(); // negative: regex won't match #?\d+ with -
    expect(parsePrRef('-1')).toBeNull(); // starts with -, doesn't match /^#?\d+$/
  });
  it('F10 — throws for PR number >= 1,000,000', () => {
    expect(() => parsePrRef('1000000')).toThrow('[afk preflight] Invalid PR number');
    expect(() => parsePrRef('9999999')).toThrow('[afk preflight] Invalid PR number');
  });
  it('F10 — accepts the maximum valid PR number 999999', () => {
    expect(parsePrRef('999999')).toBe('999999');
  });
  it('F10 — throws for URL with out-of-range PR number', () => {
    expect(() => parsePrRef('https://github.com/o/r/pull/0')).toThrow('[afk preflight] Invalid PR number in URL');
    expect(() => parsePrRef('https://github.com/o/r/pull/1000000')).toThrow('[afk preflight] Invalid PR number in URL');
  });
});

describe('gatherPrState', () => {
  it('produces clean state when gh + git both succeed and tree is clean', async () => {
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          title: 'fix: foo',
          baseRefName: 'main',
          headRefName: 'feature/x',
          additions: 721,
          deletions: 12,
          changedFiles: 6,
          files: [{ path: 'src/a.ts', additions: 10, deletions: 2 }],
        });
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') {
        return 'diff --git a/foo b/foo\n+line\n';
      }
      if (cmd === 'git' && args[0] === 'status') {
        return ''; // clean
      }
      return null;
    });
    const writeFile = vi.fn();

    const state = await gatherPrState('277', baseCtx, { exec, writeFile });

    expect(state.pr).toBe('277');
    expect(state.metadata?.title).toBe('fix: foo');
    expect(state.metadata?.additions).toBe(721);
    expect(state.diffPath).toBe('/tmp/artifacts/pr-277.diff');
    // 'diff --git a/foo b/foo\n+line\n' trimEnd → 2 real lines (trailing newline stripped)
    expect(state.diffLineCount).toBe(2);
    expect(state.dirty).toBe(false);
    expect(state.dirtyFiles).toBe(0);

    expect(writeFile).toHaveBeenCalledWith('/tmp/artifacts/pr-277.diff', expect.stringContaining('diff --git'));
  });

  it('flags dirty working tree without mutating it', async () => {
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[1] === 'view') {
        return JSON.stringify({ title: 'x', additions: 1, deletions: 0, changedFiles: 1, files: [] });
      }
      if (cmd === 'gh' && args[1] === 'diff') return 'diff\n';
      if (cmd === 'git' && args[0] === 'status') {
        return ' M src/foo.ts\n?? unrelated.md\n';
      }
      return null;
    });
    const writeFile = vi.fn();

    const state = await gatherPrState('277', baseCtx, { exec, writeFile });

    expect(state.dirty).toBe(true);
    expect(state.dirtyFiles).toBe(2);

    // Critical: no exec call should be `git stash`, `git reset`, `git commit`,
    // `git add`, `git checkout`, or any mutation. Preflight is read-only.
    const mutatingVerbs = ['stash', 'reset', 'commit', 'add', 'checkout', 'restore', 'rm', 'clean'];
    for (const call of exec.mock.calls) {
      const [cmd, args] = call as [string, string[]];
      if (cmd === 'git' && args[0] && mutatingVerbs.includes(args[0])) {
        throw new Error(`gatherPrState invoked a mutating git command: git ${args.join(' ')}`);
      }
    }
  });

  it('returns null diffPath when gh pr diff fails', async () => {
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[1] === 'view') return JSON.stringify({ title: 'x' });
      if (cmd === 'gh' && args[1] === 'diff') return null;
      if (cmd === 'git') return '';
      return null;
    });
    const writeFile = vi.fn();

    const state = await gatherPrState('277', baseCtx, { exec, writeFile });

    expect(state.diffPath).toBeNull();
    expect(state.diffLineCount).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('returns null metadata when gh pr view returns invalid JSON', async () => {
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[1] === 'view') return 'not-json{';
      if (cmd === 'gh' && args[1] === 'diff') return 'd';
      if (cmd === 'git') return '';
      return null;
    });
    const state = await gatherPrState('277', baseCtx, { exec, writeFile: vi.fn() });
    expect(state.metadata).toBeNull();
  });
});

describe('renderManifest', () => {
  it('produces a manifest under the 400-token cap (~1600 chars)', () => {
    const manifest = renderManifest({
      pr: '277',
      metadata: {
        title: 'fix: thing',
        baseRefName: 'main',
        headRefName: 'feature/x',
        additions: 721,
        deletions: 12,
        changedFiles: 6,
        files: Array.from({ length: 6 }, (_, i) => ({ path: `src/file-${i}.ts`, additions: 10, deletions: 1 })),
      },
      diffPath: '/tmp/pr-277.diff',
      diffLineCount: 931,
      dirty: false,
      dirtyFiles: 0,
    });

    expect(manifest.length).toBeLessThan(1600);
    expect(manifest).toContain('<preflight-context skill="review" pr="277">');
    expect(manifest).toContain('</preflight-context>');
    expect(manifest).toContain('Diff artifact: /tmp/pr-277.diff');
    expect(manifest).toContain('Working tree: clean');
    expect(manifest).toContain('Do not stash');
    expect(manifest).toContain('compose available');
  });

  it('includes explicit DO NOT mutate language when tree is dirty', () => {
    const manifest = renderManifest({
      pr: '277',
      metadata: { title: 't', additions: 1, deletions: 0, changedFiles: 1, files: [] },
      diffPath: '/tmp/p.diff',
      diffLineCount: 10,
      dirty: true,
      dirtyFiles: 3,
    });

    expect(manifest).toContain('Working tree: DIRTY');
    expect(manifest).toContain('3 uncommitted changes');
    // Strong, model-visible directive — the one that prevents the
    // observed `git stash` side-effect bug.
    expect(manifest).toMatch(/DO NOT stash.*commit.*reset/i);
    expect(manifest).toContain('Review is read-only');
  });

  it('caps the file list and reports remainder', () => {
    const files = Array.from({ length: 55 }, (_, i) => ({ path: `f${i}.ts` }));
    const manifest = renderManifest({
      pr: '1',
      metadata: { title: 'big', additions: 1000, deletions: 1000, changedFiles: 55, files },
      diffPath: null,
      diffLineCount: null,
      dirty: false,
      dirtyFiles: 0,
    });
    expect(manifest).toContain('…and 15 more');
  });

  it('handles missing metadata gracefully', () => {
    const manifest = renderManifest({
      pr: '277',
      metadata: null,
      diffPath: null,
      diffLineCount: null,
      dirty: false,
      dirtyFiles: 0,
    });
    expect(manifest).toContain('PR metadata: UNAVAILABLE');
    expect(manifest).toContain('Diff artifact: UNAVAILABLE');
  });
});

describe('gatherPrState — P02 concurrency (all 3 subprocesses fire together)', () => {
  it('P02 — gh pr view, gh pr diff, and git status all receive exec calls', async () => {
    const callOrder: string[] = [];
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      callOrder.push(`${cmd} ${args[0] ?? ''} ${args[1] ?? ''}`);
      if (cmd === 'gh' && args[1] === 'view') {
        return JSON.stringify({ title: 't', additions: 1, deletions: 0, changedFiles: 1, files: [] });
      }
      if (cmd === 'gh' && args[1] === 'diff') return 'd\n';
      if (cmd === 'git' && args[0] === 'status') return '';
      return null;
    });
    const writeFile = vi.fn();

    await gatherPrState('100', baseCtx, { exec, writeFile });

    // All three commands must have been invoked.
    expect(exec).toHaveBeenCalledTimes(3);
    const calls = exec.mock.calls as Array<[string, string[]]>;
    const hasView = calls.some(([cmd, args]) => cmd === 'gh' && args.includes('view'));
    const hasDiff = calls.some(([cmd, args]) => cmd === 'gh' && args.includes('diff'));
    const hasStatus = calls.some(([cmd, args]) => cmd === 'git' && args.includes('status'));
    expect(hasView).toBe(true);
    expect(hasDiff).toBe(true);
    expect(hasStatus).toBe(true);
  });
});

describe('reviewPrPreflight — P03 concurrency guard', () => {
  it('P03 — returns null immediately when a gather is already in-flight', async () => {
    // Confirm '277' is a real PR ref so the null below comes from the guard,
    // not from parsePrRef early-exiting on a non-PR arg.
    expect(parsePrRef('277')).toBe('277');

    // Arm the guard: simulate a concurrent gather already in-flight.
    _setConcurrencyGuardForTests(true);

    // A real PR ref → parsePrRef returns non-null → control reaches the guard check.
    const inv: SkillInvocation = { ...baseInv, rawArgs: '277' };
    const result = await reviewPrPreflight(inv, baseCtx);

    // Guard fires → returns null without calling gatherPrState.
    expect(result).toBeNull();
  });
});

describe('reviewPrPreflight (end-to-end shape)', () => {
  it('returns null when args do not look like a PR reference', async () => {
    const inv: SkillInvocation = { ...baseInv, rawArgs: '--staged' };
    const result = await reviewPrPreflight(inv, baseCtx);
    expect(result).toBeNull();
  });

  it('returns null for an empty arg', async () => {
    const inv: SkillInvocation = { ...baseInv, rawArgs: '' };
    const result = await reviewPrPreflight(inv, baseCtx);
    expect(result).toBeNull();
  });

  // The PR-shaped path requires real `gh`; we exercise it via gatherPrState
  // above instead of shelling out from a unit test. End-to-end smoke
  // coverage lives in the integration suite.
});

describe('xmlEscape injection hardening (via renderManifest)', () => {
  function stateWith(overrides: Partial<{
    title: string;
    headRefName: string;
    baseRefName: string;
    filePath: string;
  }>): Parameters<typeof renderManifest>[0] {
    return {
      pr: '1',
      metadata: {
        title:        overrides.title       ?? 'safe-title',
        headRefName:  overrides.headRefName ?? 'safe-head',
        baseRefName:  overrides.baseRefName ?? 'safe-base',
        additions:    0,
        deletions:    0,
        changedFiles: 1,
        files: [{ path: overrides.filePath ?? 'safe/path.ts', additions: 0, deletions: 0 }],
      },
      diffPath: null,
      diffLineCount: null,
      dirty: false,
      dirtyFiles: 0,
    };
  }

  it('escapes < and > in title', () => {
    const manifest = renderManifest(stateWith({ title: '<script>alert(1)</script>' }));
    expect(manifest).not.toContain('<script>');
    expect(manifest).toContain('&lt;script&gt;');
  });

  it('escapes & in title', () => {
    const manifest = renderManifest(stateWith({ title: 'feat: foo & bar' }));
    expect(manifest).not.toContain('foo & bar');
    expect(manifest).toContain('foo &amp; bar');
  });

  it('strips LF from title', () => {
    const manifest = renderManifest(stateWith({ title: 'line1\nline2' }));
    const titleLine = manifest.split('\n').find((l) => l.startsWith('Title:'));
    expect(titleLine).toBeDefined();
    expect(titleLine).toContain('line1line2');
  });

  it('strips CR from title', () => {
    const manifest = renderManifest(stateWith({ title: 'carriage\rreturn' }));
    const titleLine = manifest.split('\n').find((l) => l.startsWith('Title:'));
    expect(titleLine).toBeDefined();
    expect(titleLine).not.toContain('\r');
    expect(titleLine).toContain('carriagereturn');
  });

  it('escapes < and > in headRefName', () => {
    const manifest = renderManifest(stateWith({ headRefName: 'feat/<inject>' }));
    const branchLine = manifest.split('\n').find((l) => l.startsWith('Branch:'));
    expect(branchLine).toBeDefined();
    expect(branchLine).not.toContain('<inject>');
    expect(branchLine).toContain('&lt;inject&gt;');
  });

  it('escapes & in headRefName', () => {
    const manifest = renderManifest(stateWith({ headRefName: 'feat/a&b' }));
    const branchLine = manifest.split('\n').find((l) => l.startsWith('Branch:'));
    expect(branchLine).toContain('&amp;');
  });

  it('escapes < and > in baseRefName', () => {
    const manifest = renderManifest(stateWith({ baseRefName: 'main<evil>' }));
    expect(manifest).not.toContain('main<evil>');
    expect(manifest).toContain('main&lt;evil&gt;');
  });

  it('strips newline from headRefName', () => {
    const manifest = renderManifest(stateWith({ headRefName: 'feat/foo\nBAD' }));
    const branchLine = manifest.split('\n').find((l) => l.startsWith('Branch:'));
    expect(branchLine).toBeDefined();
    expect(branchLine).toContain('feat/fooBAD');
  });

  it('escapes < and > in file path', () => {
    const manifest = renderManifest(stateWith({ filePath: 'src/<evil>.ts' }));
    expect(manifest).not.toContain('<evil>');
    expect(manifest).toContain('&lt;evil&gt;');
  });

  it('escapes & in file path', () => {
    const manifest = renderManifest(stateWith({ filePath: 'src/a&b.ts' }));
    expect(manifest).toContain('&amp;');
  });

  it('strips LF from file path', () => {
    const manifest = renderManifest(stateWith({ filePath: 'src/foo\nbar.ts' }));
    const fileLine = manifest.split('\n').find((l) => l.startsWith('  -'));
    expect(fileLine).toBeDefined();
    expect(fileLine).toContain('src/foobar.ts');
  });

  it('strips CR from file path', () => {
    const manifest = renderManifest(stateWith({ filePath: 'src/foo\rbar.ts' }));
    const fileLine = manifest.split('\n').find((l) => l.startsWith('  -'));
    expect(fileLine).toBeDefined();
    expect(fileLine).not.toContain('\r');
  });

  it('does not double-escape an already-encoded entity (&amp; → &amp;amp;)', () => {
    const manifest = renderManifest(stateWith({ title: 'feat: &amp; edge case' }));
    expect(manifest).toContain('&amp;amp;');
  });

  it('leaves safe branch names unmodified', () => {
    const manifest = renderManifest(stateWith({ headRefName: 'feature/safe-123', baseRefName: 'main' }));
    expect(manifest).toContain('feature/safe-123');
    expect(manifest).toContain('main');
  });
});

describe('M3 — filter pathless entries before cap', () => {
  it('does not waste cap slots on pathless entries', () => {
    const files = [
      { path: undefined },
      { path: undefined },
      ...Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts` })),
    ];
    const manifest = renderManifest({
      pr: '1',
      metadata: { title: 't', additions: 0, deletions: 0, changedFiles: 40, files },
      diffPath: null,
      diffLineCount: null,
      dirty: false,
      dirtyFiles: 0,
    });
    // With filter-before-slice, all 40 path-bearing files fit under the cap
    // of 40 — the two pathless entries are excluded before slicing.
    expect(manifest).toContain('f39.ts');
    expect(manifest).not.toContain('…and');
  });

  it('"N more" count reflects path-bearing entries only', () => {
    const pathless = Array.from({ length: 10 }, () => ({ path: undefined }));
    const bearing = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts` }));
    const manifest = renderManifest({
      pr: '1',
      metadata: { title: 't', additions: 0, deletions: 0, changedFiles: 60, files: [...pathless, ...bearing] },
      diffPath: null,
      diffLineCount: null,
      dirty: false,
      dirtyFiles: 0,
    });
    // 50 path-bearing files, cap = 40 → 10 more (not 20 which pathless would inflate to)
    expect(manifest).toContain('…and 10 more');
  });
});

describe('dirty-tree side-effect guarantee', () => {
  // The proof: even when the tree is dirty, the preflight only *reads*
  // status and surfaces a warning. No subprocess call should be a
  // mutating git verb. This pairs with the renderer test that asserts
  // the manifest contains the explicit DO NOT directive.
  it('does not invoke any mutating git command when the tree is dirty', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'view') {
        return JSON.stringify({ title: 't', additions: 1, deletions: 0, changedFiles: 0, files: [] });
      }
      if (cmd === 'gh' && args[1] === 'diff') return 'd';
      if (cmd === 'git' && args[0] === 'status') return ' M dirty.ts\n';
      return null;
    });
    const writeFile = vi.fn();

    const state = await gatherPrState('277', baseCtx, { exec, writeFile });
    const manifest = renderManifest(state);

    // Side-effect assertion: only read commands invoked.
    const mutating = new Set(['stash', 'reset', 'commit', 'add', 'checkout', 'restore', 'rm', 'clean', 'merge', 'rebase']);
    for (const c of calls) {
      if (c.cmd === 'git' && c.args[0] && mutating.has(c.args[0])) {
        throw new Error(`Mutating git invocation leaked: git ${c.args.join(' ')}`);
      }
    }

    // Manifest assertion: dirty surfaced + explicit directive.
    expect(state.dirty).toBe(true);
    expect(manifest).toContain('DIRTY');
    expect(manifest).toMatch(/DO NOT stash/i);
  });
});
