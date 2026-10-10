/**
 * Tests for workspace revalidation before continuation dispatches.
 *
 * Covers:
 *  - clean snapshot (all fields match)
 *  - branch drift detection
 *  - HEAD SHA drift detection (full and abbreviated)
 *  - dirty-count drift detection
 *  - partial snapshot (absent fields not checked)
 *  - git command failure (surfaced as commandFailed, not thrown)
 *  - empty snapshot (nothing to check → always clean)
 *
 * @module agent/subagent/workspace-revalidation.test
 */

import { describe, it, expect, vi } from 'vitest';
import { revalidateWorkspace } from './workspace-revalidation.js';
import type { WorkspaceSnapshot } from './workspace-revalidation.js';

type ExecFn = (file: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

/**
 * Build an injectable exec function that simulates git command responses.
 */
function makeExec(responses: Record<string, string>): ExecFn {
  return async (_file: string, args: string[], _opts?: { cwd?: string }) => {
    const key = args.join(' ');
    const stdout = responses[key];
    if (stdout === undefined) {
      throw new Error(`git command not stubbed: ${key}`);
    }
    return { stdout, stderr: '' };
  };
}

/** An exec that always throws (simulates git unavailable). */
const failingExec: ExecFn = async () => {
  throw new Error('git not found');
};

describe('revalidateWorkspace', () => {
  describe('empty snapshot', () => {
    it('returns clean when no fields to check', async () => {
      const result = await revalidateWorkspace({}, { execFile: failingExec });
      expect(result.clean).toBe(true);
      expect(result.drifts).toHaveLength(0);
      expect(result.commandFailed).toBeUndefined();
      expect(result.summary).toBe('');
    });
  });

  describe('clean snapshot', () => {
    it('returns clean when all fields match live state', async () => {
      const snapshot: WorkspaceSnapshot = {
        gitBranch: 'feature/auth',
        headSha: 'abc123def456',
        dirtyCount: 2,
      };
      const exec = makeExec({
        'rev-parse --abbrev-ref HEAD': 'feature/auth\n',
        'rev-parse HEAD': 'abc123def456\n',
        'status --porcelain': 'M file1.ts\nM file2.ts\n',
      });
      const result = await revalidateWorkspace(snapshot, { execFile: exec });
      expect(result.clean).toBe(true);
      expect(result.drifts).toHaveLength(0);
      expect(result.summary).toBe('');
    });
  });

  describe('branch drift', () => {
    it('detects branch mismatch', async () => {
      const snapshot: WorkspaceSnapshot = { gitBranch: 'feature/auth' };
      const exec = makeExec({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
      const result = await revalidateWorkspace(snapshot, { execFile: exec });
      expect(result.clean).toBe(false);
      expect(result.drifts).toHaveLength(1);
      expect(result.drifts[0]).toMatchObject({
        field: 'gitBranch',
        snapshot: 'feature/auth',
        live: 'main',
      });
      expect(result.summary).toContain('gitBranch');
    });

    it('does not check branch when snapshot.gitBranch is absent', async () => {
      const exec = makeExec({
        'rev-parse HEAD': 'abc123\n',
        'status --porcelain': '',
      });
      const result = await revalidateWorkspace(
        { headSha: 'abc123', dirtyCount: 0 },
        { execFile: exec },
      );
      expect(result.clean).toBe(true);
      expect(result.drifts).toHaveLength(0);
    });
  });

  describe('HEAD SHA drift', () => {
    it('detects SHA mismatch (full vs full)', async () => {
      const snapshot: WorkspaceSnapshot = { headSha: 'aaaa1111' };
      const exec = makeExec({ 'rev-parse HEAD': 'bbbb2222\n' });
      const result = await revalidateWorkspace(snapshot, { execFile: exec });
      expect(result.clean).toBe(false);
      expect(result.drifts[0]).toMatchObject({ field: 'headSha', snapshot: 'aaaa1111', live: 'bbbb2222' });
    });

    it('accepts abbreviated snapshot SHA (prefix match)', async () => {
      const snapshot: WorkspaceSnapshot = { headSha: 'abc123' }; // abbreviated
      const exec = makeExec({ 'rev-parse HEAD': 'abc123def456789\n' }); // full SHA
      const result = await revalidateWorkspace(snapshot, { execFile: exec });
      expect(result.clean).toBe(true);
      expect(result.drifts).toHaveLength(0);
    });

    it('detects when abbreviated SHA does not match full SHA prefix', async () => {
      const snapshot: WorkspaceSnapshot = { headSha: 'abc123' };
      const exec = makeExec({ 'rev-parse HEAD': 'def456abc123000\n' });
      const result = await revalidateWorkspace(snapshot, { execFile: exec });
      expect(result.clean).toBe(false);
      expect(result.drifts[0].field).toBe('headSha');
    });

    it('skips SHA check when snapshot.headSha is too short (< 4 chars)', async () => {
      // A very short SHA could match any SHA as a prefix — skip to avoid false-clean.
      const exec = makeExec({ 'rev-parse HEAD': 'abcdef123456\n' });
      const result = await revalidateWorkspace({ headSha: 'ab' }, { execFile: exec }); // < 4 chars
      expect(result.clean).toBe(true);
      expect(result.drifts).toHaveLength(0);
    });

    it('skips SHA check when snapshot.headSha is empty string', async () => {
      const exec = makeExec({ 'rev-parse HEAD': 'abcdef123456\n' });
      const result = await revalidateWorkspace({ headSha: '' }, { execFile: exec });
      expect(result.clean).toBe(true);
    });
  });

  describe('dirty-count drift', () => {
    it('detects dirty-count increase', async () => {
      const snapshot: WorkspaceSnapshot = { dirtyCount: 1 };
      const exec = makeExec({ 'status --porcelain': 'M a.ts\nM b.ts\nM c.ts\n' });
      const result = await revalidateWorkspace(snapshot, { execFile: exec });
      expect(result.clean).toBe(false);
      expect(result.drifts[0]).toMatchObject({ field: 'dirtyCount', snapshot: 1, live: 3 });
    });

    it('accepts exact dirty count match (including zero)', async () => {
      const exec = makeExec({ 'status --porcelain': '' });
      const result = await revalidateWorkspace({ dirtyCount: 0 }, { execFile: exec });
      expect(result.clean).toBe(true);
    });
  });

  describe('git command failure', () => {
    it('returns commandFailed:true when git is unavailable, does not throw', async () => {
      const snapshot: WorkspaceSnapshot = { gitBranch: 'main' };
      const result = await revalidateWorkspace(snapshot, { execFile: failingExec });
      expect(result.clean).toBe(false);
      expect(result.commandFailed).toBe(true);
      expect(result.drifts).toHaveLength(0); // command failed, not a drift per se
      expect(result.summary).toContain('indeterminate');
    });

    it('summarizes both drift and command-fail when some commands succeed and some fail', async () => {
      // branch check succeeds and drifts; SHA check throws.
      const snapshot: WorkspaceSnapshot = { gitBranch: 'feat', headSha: 'abcd1234' }; // ≥4 chars so check fires
      const partialExec: ExecFn = async (_f, args) => {
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
        throw new Error('sha command failed');
      };
      const result = await revalidateWorkspace(snapshot, { execFile: partialExec });
      expect(result.clean).toBe(false);
      expect(result.drifts).toHaveLength(1);
      expect(result.drifts[0].field).toBe('gitBranch');
      expect(result.commandFailed).toBe(true);
      expect(result.summary).toContain('gitBranch');
      expect(result.summary).toContain('additional git commands also failed');
    });
  });

  describe('fallback cwd', () => {
    it('uses snapshot.cwd as git working directory when present', async () => {
      const cwdSeen: string[] = [];
      const exec: ExecFn = async (_f, args, opts) => {
        if (opts?.cwd) cwdSeen.push(opts.cwd);
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
        throw new Error('unexpected cmd');
      };
      await revalidateWorkspace({ cwd: '/my/project', gitBranch: 'main' }, { execFile: exec });
      expect(cwdSeen.some((c) => c === '/my/project')).toBe(true);
    });

    it('uses fallbackCwd when snapshot.cwd is absent', async () => {
      const cwdSeen: string[] = [];
      const exec: ExecFn = async (_f, args, opts) => {
        if (opts?.cwd) cwdSeen.push(opts.cwd);
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
        throw new Error('unexpected cmd');
      };
      await revalidateWorkspace({ gitBranch: 'main' }, { fallbackCwd: '/fallback', execFile: exec });
      expect(cwdSeen.some((c) => c === '/fallback')).toBe(true);
    });
  });

  describe('multiple simultaneous drifts', () => {
    it('reports all drifted fields in summary', async () => {
      const snapshot: WorkspaceSnapshot = {
        gitBranch: 'feature/x',
        headSha: 'aaaa',
        dirtyCount: 0,
      };
      const exec = makeExec({
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'rev-parse HEAD': 'bbbb\n',
        'status --porcelain': 'M changed.ts\n',
      });
      const result = await revalidateWorkspace(snapshot, { execFile: exec });
      expect(result.clean).toBe(false);
      expect(result.drifts).toHaveLength(3);
      expect(result.summary).toContain('gitBranch');
      expect(result.summary).toContain('headSha');
      expect(result.summary).toContain('dirtyCount');
    });
  });
});
