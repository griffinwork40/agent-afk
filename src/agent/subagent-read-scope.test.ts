import { describe, it, expect } from 'vitest';
import path from 'path';
import { computeInheritedReadRoots, readOpenRootFor } from './subagent-read-scope.js';

const FS_ROOT = path.parse(path.resolve('.')).root || path.sep;

describe('readOpenRootFor', () => {
  it('returns the volume root for an absolute path', () => {
    expect(readOpenRootFor('/Users/x/proj/.afk-worktrees/wt')).toBe(FS_ROOT);
  });
  it('falls back to process.cwd volume root when base is undefined', () => {
    expect(readOpenRootFor(undefined)).toBe(FS_ROOT);
  });
});

describe('computeInheritedReadRoots', () => {
  describe('unconfined parent (the common top-level `afk`/`afk i` case)', () => {
    it('grants read-open when parent has no readRoots and no cwd', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: undefined,
        childCwd: '/repo/.afk-worktrees/iso-1',
      });
      expect(roots).toEqual([FS_ROOT]);
    });

    it('read-open root lexically contains sibling worktrees AND ~/.afk paths', () => {
      const [root] = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: undefined,
        childCwd: '/repo/.afk-worktrees/iso-1',
      })!;
      // A path is admitted iff path.relative(root, target) does not escape.
      for (const target of [
        '/repo/.afk-worktrees/other-wt/src/x.ts',
        '/Users/me/.afk/state/skill-preflight/pr-1.diff',
        '/repo/src/agent/subagent.ts',
      ]) {
        expect(path.relative(root!, target).startsWith('..')).toBe(false);
      }
    });
  });

  describe('confined parent', () => {
    it('unions child cwd + parent cwd + worktree main root', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: '/repo',
        childCwd: '/repo/.afk-worktrees/iso-1',
        worktreeMainRoot: '/repo',
      });
      expect(new Set(roots)).toEqual(new Set(['/repo/.afk-worktrees/iso-1', '/repo']));
    });

    it('inherits explicit parent readRoots (transitive propagation)', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: ['/repo', '/extra/allowed-dir'],
        parentCwd: '/repo',
        childCwd: '/repo/.afk-worktrees/iso-2',
      });
      expect(new Set(roots)).toEqual(
        new Set(['/repo/.afk-worktrees/iso-2', '/repo', '/extra/allowed-dir']),
      );
    });

    it('propagates a read-open parent transitively (grandchild stays read-open)', () => {
      // A read-open child's effective readRoots is [FS_ROOT]; when it forks, that
      // value arrives here as the (explicit) parentReadRoots.
      const roots = computeInheritedReadRoots({
        parentReadRoots: [FS_ROOT],
        parentCwd: '/repo/.afk-worktrees/iso-1',
        childCwd: '/repo/.afk-worktrees/iso-1/sub',
      });
      expect(roots).toContain(FS_ROOT); // grandchild remains read-open
    });

    it('never narrows below the parent scope', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: ['/a', '/b'],
        parentCwd: '/a',
        childCwd: '/a/child',
      })!;
      expect(roots).toEqual(expect.arrayContaining(['/a', '/b']));
    });

    it('returns undefined when the only root is the child cwd (== provider default, no broadening)', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: '/repo',
        childCwd: '/repo',
        worktreeMainRoot: undefined,
      });
      // Nothing broader than [cwd] → leave provider default untouched.
      expect(roots).toBeUndefined();
    });

    it('returns undefined when worktree main root equals the child cwd (defensive)', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: '/repo/.afk-worktrees/wt',
        childCwd: '/repo/.afk-worktrees/wt',
        worktreeMainRoot: '/repo/.afk-worktrees/wt',
      });
      expect(roots).toBeUndefined();
    });
  });

  describe('degenerate inputs', () => {
    it('returns undefined when confined parent has no usable roots (leave provider default)', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: [],
        parentCwd: undefined,
        childCwd: undefined,
      });
      expect(roots).toBeUndefined();
    });

    it('returns undefined for an unconfined parent when the child also has no cwd (naturally unconfined)', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: undefined,
        childCwd: undefined,
      });
      expect(roots).toBeUndefined();
    });
  });

  describe('afkStateRoot grant (confined forks reach ~/.afk/state — Gap A)', () => {
    const STATE = '/Users/me/.afk/state';

    it('folds the AFK state dir into a confined worktree fork union', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: '/repo/.afk-worktrees/wt',
        childCwd: '/repo/.afk-worktrees/wt',
        worktreeMainRoot: '/repo',
        afkStateRoot: STATE,
      })!;
      expect(new Set(roots)).toEqual(
        new Set(['/repo/.afk-worktrees/wt', '/repo', STATE]),
      );
      // A skill-preflight staged input under the state dir is now admitted
      // (containment is lexical: path.relative does not escape the root).
      expect(
        path.relative(STATE, `${STATE}/skill-preflight/pr-548.diff`).startsWith('..'),
      ).toBe(false);
    });

    it('grants [cwd, state] even with no worktree main root (state lifts the fork out of the [cwd] default)', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: '/plain/repo',
        childCwd: '/plain/repo',
        worktreeMainRoot: undefined,
        afkStateRoot: STATE,
      });
      // Without afkStateRoot this is the "only root is cwd" case → undefined.
      expect(new Set(roots)).toEqual(new Set(['/plain/repo', STATE]));
    });

    it('is ignored for an unconfined (read-open) parent — read-open already covers state', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: undefined,
        childCwd: '/repo/.afk-worktrees/wt',
        afkStateRoot: STATE,
      });
      expect(roots).toEqual([FS_ROOT]); // read-open, not [.., STATE]
    });

    it('omitting afkStateRoot preserves the pre-fix behaviour (back-compat)', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: '/repo',
        childCwd: '/repo',
        worktreeMainRoot: undefined,
      });
      expect(roots).toBeUndefined();
    });

    it('never derives ~/.afk/config — only the exact state root passed', () => {
      const roots = computeInheritedReadRoots({
        parentReadRoots: undefined,
        parentCwd: '/repo/.afk-worktrees/wt',
        childCwd: '/repo/.afk-worktrees/wt',
        worktreeMainRoot: '/repo',
        afkStateRoot: STATE,
      })!;
      const CONFIG = '/Users/me/.afk/config';
      // The credential dir is a sibling of state; it must never be granted, and
      // no granted root may lexically admit a config path.
      expect(roots.some((r) => path.resolve(r) === CONFIG)).toBe(false);
      expect(
        roots.every((r) => path.relative(r, `${CONFIG}/afk.env`).startsWith('..')),
      ).toBe(true);
    });
  });
});
