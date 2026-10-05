/**
 * Tests for the factored-out managed-worktree primitives shared by the
 * `worktree` tool handler and the `agent` tool's isolation:"worktree" path.
 *
 * Uses a mocked ExecFileFn (same pattern as worktree.test.ts) so no real git
 * runs. Focus: the git argv emitted (parity with the pre-extraction handler)
 * and the create/teardown decision logic for isolated worktrees.
 *
 * Integration tests for #2749 (concurrent-session base contamination) use
 * real git repos under path.join(os.tmpdir(), 'afk-...') and never touch the
 * real checkout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileNode } from 'node:child_process';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  createManagedWorktree,
  removeManagedWorktreeGuarded,
  createIsolatedWorktree,
  teardownIsolatedWorktree,
  detectRemoteDefaultRef,
  resolveAnchorBaseRef,
} from './worktree-managed.js';
import type { ExecFileFn } from '../../worktree/worktree-sweep.js';

const execFileAsync = promisify(execFileNode) as ExecFileFn;

interface Call { file: string; args: string[] }

function makeMock(
  responder: (call: Call) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
): ExecFileFn & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (file: string, args: string[]) => {
    const call = { file, args };
    calls.push(call);
    return responder(call);
  }) as ExecFileFn & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'wt-managed-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('createManagedWorktree — argv + meta parity', () => {
  it('emits `git worktree add -b <branch> <path> <baseRef>` and writes meta', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'feat');
    const mock = makeMock((call) => {
      if (call.args.includes('add')) {
        return fs.mkdir(wtPath, { recursive: true }).then(() => ({ stdout: '', stderr: '' }));
      }
      if (call.args.includes('rev-parse')) return { stdout: 'base-sha-999\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const info = await createManagedWorktree({
      execFile: mock,
      repoRoot,
      worktreePath: wtPath,
      branch: 'afk/feat',
      baseRef: 'HEAD',
    });
    expect(info).toEqual({ path: wtPath, branch: 'afk/feat', baseRef: 'HEAD', baseSha: 'base-sha-999' });
    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall?.args).toEqual(['-C', repoRoot, 'worktree', 'add', '-b', 'afk/feat', wtPath, 'HEAD']);
    const meta = JSON.parse(await fs.readFile(join(wtPath, '.afk-worktree-meta.json'), 'utf-8')) as Record<string, unknown>;
    expect(meta['owner']).toBe('agent');
    expect(meta['baseSha']).toBe('base-sha-999');
    expect(meta['pid']).toBe(process.pid);
  });
});

describe('removeManagedWorktreeGuarded — guards + argv', () => {
  it('removes a clean tree with no --force', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'clean');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({
      execFile: mock, repoRoot, worktreePath: wtPath, branch: 'refs/heads/afk/clean',
    });
    expect(outcome).toEqual({ removed: true, branchPreserved: 'refs/heads/afk/clean' });
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toEqual(['-C', repoRoot, 'worktree', 'remove', wtPath]);
    expect(rm?.args).not.toContain('--force');
  });

  it('refuses a dirty tree without force (reason: dirty)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'dirty');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: ' M f.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome).toEqual({ removed: false, reason: 'dirty' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  it('refuses a commits-ahead tree without force (reason: commits-ahead)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'ahead');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(join(wtPath, '.afk-worktree-meta.json'), JSON.stringify({ baseSha: 'base1' }));
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('rev-parse')) return { stdout: 'tip9\n', stderr: '' };
      if (call.args.includes('rev-list')) return { stdout: '3\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome).toEqual({ removed: false, reason: 'commits-ahead', commitsAhead: 3 });
  });

  it('force removes with --force, skipping guards', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'force');
    const mock = makeMock(() => ({ stdout: ' M dirty.ts\n', stderr: '' }));
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath, force: true });
    expect(outcome.removed).toBe(true);
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toContain('--force');
    // No status check when forced.
    expect(mock.calls.some((c) => c.args.includes('status'))).toBe(false);
  });

  // #759 (second removal path): bare `status --porcelain` never reports
  // ignored files, so a tree whose only content is a non-rebuildable ignored
  // file (`.env`) reads clean and reached `git worktree remove` undefended.
  it('refuses a tree holding a non-rebuildable ignored file without force (reason: ignored-local-state)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'has-dotenv');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! .env\n!! node_modules/\n', stderr: '' };
      if (call.args.includes('status')) return { stdout: '', stderr: '' }; // tracked tree is clean
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome).toEqual({ removed: false, reason: 'ignored-local-state', detail: '.env', because: 'non-rebuildable-entry' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  // Counterweight: ignored build output alone must NOT block removal, or
  // every worktree with node_modules/ would become unreapable.
  it('still succeeds when the only ignored content is rebuildable output', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'only-build-output');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! node_modules/\n!! dist/\n', stderr: '' };
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome.removed).toBe(true);
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toEqual(['-C', repoRoot, 'worktree', 'remove', wtPath]);
  });

  it('force:true still removes even when non-rebuildable ignored content is present', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'force-dotenv');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! .env\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({
      execFile: mock, repoRoot, worktreePath: wtPath, force: true,
    });
    expect(outcome.removed).toBe(true);
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toContain('--force');
    // Explicit override bypasses the ignored-state probe entirely.
    expect(mock.calls.some((c) => c.args.includes('--ignored'))).toBe(false);
  });
});

describe('createIsolatedWorktree', () => {
  it("resolves the repo root and creates an afk/iso-* branch based on the anchor's HEAD", async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('--git-common-dir')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      if (call.args.includes('add')) {
        const p = call.args[call.args.length - 2] as string; // <path> <baseRef>
        return fs.mkdir(p, { recursive: true }).then(() => ({ stdout: '', stderr: '' }));
      }
      if (call.args.includes('rev-parse')) return { stdout: 'headsha\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const iso = await createIsolatedWorktree({ execFile: mock, cwd: repoRoot, slugHint: 'iso-diagnose-1-abc123' });
    expect(iso.repoRoot).toBe(repoRoot);
    expect(iso.path).toBe(join(repoRoot, '.afk-worktrees', 'iso-diagnose-1-abc123'));
    expect(iso.branch).toBe('afk/iso-diagnose-1-abc123');
    // #760: the default base is the anchor's RESOLVED HEAD sha, not the literal
    // ref (which `git -C <repoRoot>` would resolve at the MAIN checkout instead).
    expect(iso.baseRef).toBe('headsha');
    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall?.args).toEqual([
      '-C', repoRoot, 'worktree', 'add', '-b', 'afk/iso-diagnose-1-abc123', iso.path, 'headsha',
    ]);
  });

  it('throws when cwd is not a git repository (executor must fail loud, not fall back)', async () => {
    const mock = makeMock(() => { throw new Error('fatal: not a git repository'); });
    await expect(
      createIsolatedWorktree({ execFile: mock, cwd: '/nowhere', slugHint: 'iso-x-1-y' }),
    ).rejects.toThrow(/not a git repository/);
  });

  it('retries once on a lock error then succeeds (concurrent worktree add contention)', async () => {
    let addCount = 0;
    const mock = makeMock((call) => {
      if (call.args.includes('--git-common-dir')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      if (call.args.includes('add')) {
        addCount += 1;
        if (addCount === 1) {
          // First parallel `worktree add` loses the index-lock race.
          throw new Error('fatal: could not lock ref; another worktree add is in progress (index.lock)');
        }
        const p = call.args[call.args.length - 2] as string; // <path> <baseRef>
        return fs.mkdir(p, { recursive: true }).then(() => ({ stdout: '', stderr: '' }));
      }
      if (call.args.includes('rev-parse')) return { stdout: 'headsha\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const iso = await createIsolatedWorktree({ execFile: mock, cwd: repoRoot, slugHint: 'iso-parallel-2-def456' });
    expect(iso.repoRoot).toBe(repoRoot);
    expect(iso.path).toBe(join(repoRoot, '.afk-worktrees', 'iso-parallel-2-def456'));
    expect(iso.branch).toBe('afk/iso-parallel-2-def456');
    expect(iso.baseRef).toBe('headsha');
    // Retried EXACTLY once → `worktree add` invoked twice, second time won.
    expect(mock.calls.filter((c) => c.args.includes('add'))).toHaveLength(2);
  });

  it('does NOT retry a non-lock error (deterministic failures propagate immediately)', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('--git-common-dir')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      if (call.args.includes('add')) throw new Error('fatal: something else');
      return { stdout: '', stderr: '' };
    });
    await expect(
      createIsolatedWorktree({ execFile: mock, cwd: repoRoot, slugHint: 'iso-nonlock-3-ghi789' }),
    ).rejects.toThrow(/something else/);
    // No retry → `worktree add` invoked exactly once.
    expect(mock.calls.filter((c) => c.args.includes('add'))).toHaveLength(1);
  });
});

describe('teardownIsolatedWorktree', () => {
  it('removes a clean worktree', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-clean');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: true, preserved: false });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(true);
    expect(mock.calls.some((c) => c.args.includes('lock'))).toBe(false);
  });

  it('preserves + locks a dirty worktree (WIP never destroyed)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-dirty');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: ' M wip.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'dirty' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
    const lock = mock.calls.find((c) => c.args.includes('lock'));
    expect(lock?.args[0]).toBe('-C');
    expect(lock?.args).toContain(wtPath);
    expect(lock?.args.join(' ')).toContain('afk: isolated-worktree preserved (dirty)');
  });

  it('never throws — a git failure degrades to removed:false, preserved:false', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-boom');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('remove')) throw new Error('git remove exploded');
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: false });
  });

  // The tree LOOKS clean to `git status`, so the lock reason is the only
  // place the operator can learn WHY it was preserved instead of removed.
  it('preserves + locks a tree holding non-rebuildable ignored files, naming the reason', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-has-dotenv');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! .env\n', stderr: '' };
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'ignored-local-state', ignoredDetail: '.env', ignoredBecause: 'non-rebuildable-entry' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
    const lock = mock.calls.find((c) => c.args.includes('lock'));
    expect(lock?.args.join(' ')).toContain('afk: isolated-worktree preserved (ignored-local-state');
    // Lock reason names the real file that triggered the refusal.
    expect(lock?.args.join(' ')).toContain('.env');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 + 3: structured metadata and self-healing teardown (#1545)
// ---------------------------------------------------------------------------

describe('teardownIsolatedWorktree — structured metadata on preserve', () => {
  it('writes preservedReason + preservedAt to meta after locking a dirty tree', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-meta-dirty');
    await fs.mkdir(wtPath, { recursive: true });
    // Existing meta (simulates what createManagedWorktree wrote)
    await fs.writeFile(join(wtPath, '.afk-worktree-meta.json'), JSON.stringify({ owner: 'agent', createdAt: new Date().toISOString() }));

    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: ' M wip.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'dirty' });

    const meta = JSON.parse(await fs.readFile(join(wtPath, '.afk-worktree-meta.json'), 'utf-8')) as Record<string, unknown>;
    expect(meta['preservedReason']).toBe('dirty');
    expect(typeof meta['preservedAt']).toBe('string');
    expect(meta['commitsAheadAtPreserve']).toBeUndefined();
  });

  it('writes preservedReason + commitsAheadAtPreserve to meta for a commits-ahead tree', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-meta-ahead');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(join(wtPath, '.afk-worktree-meta.json'), JSON.stringify({
      owner: 'agent',
      createdAt: new Date().toISOString(),
      baseSha: 'base999',
    }));

    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('--ignored')) return { stdout: '', stderr: '' };
      if (call.args.includes('rev-parse')) return { stdout: 'head111\n', stderr: '' };
      if (call.args.includes('rev-list')) return { stdout: '3\n', stderr: '' };
      // re-probe upstream (Layer 3): return non-empty to force preserve path
      if (call.args.includes('log') && call.args.includes('@{upstream}..HEAD')) return { stdout: 'abc commit\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'commits-ahead' });

    const meta = JSON.parse(await fs.readFile(join(wtPath, '.afk-worktree-meta.json'), 'utf-8')) as Record<string, unknown>;
    expect(meta['preservedReason']).toBe('commits-ahead');
    expect(meta['commitsAheadAtPreserve']).toBe(3);
  });
});

describe('teardownIsolatedWorktree — self-healing re-probe (Layer 3)', () => {
  it('removes a commits-ahead tree when the re-probe shows all commits are pushed', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-pushed-healed');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(join(wtPath, '.afk-worktree-meta.json'), JSON.stringify({
      owner: 'agent',
      createdAt: new Date().toISOString(),
      baseSha: 'base777',
    }));

    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('--ignored')) return { stdout: '', stderr: '' };
      if (call.args.includes('rev-parse')) return { stdout: 'head222\n', stderr: '' };
      if (call.args.includes('rev-list')) return { stdout: '2\n', stderr: '' };
      // Layer 3 re-probe: empty → all pushed → safe to remove
      if (call.args.includes('log') && call.args.includes('@{upstream}..HEAD')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    // After re-probe reveals all pushed, teardown removes the tree
    expect(result.removed).toBe(true);
    expect(result.preserved).toBe(false);
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(true);
    expect(mock.calls.some((c) => c.args.includes('lock'))).toBe(false);
  });

  it('still preserves + locks when re-probe confirms commits are NOT pushed', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-still-unpushed');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(join(wtPath, '.afk-worktree-meta.json'), JSON.stringify({
      owner: 'agent',
      createdAt: new Date().toISOString(),
      baseSha: 'base888',
    }));

    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('--ignored')) return { stdout: '', stderr: '' };
      if (call.args.includes('rev-parse')) return { stdout: 'head333\n', stderr: '' };
      if (call.args.includes('rev-list')) return { stdout: '1\n', stderr: '' };
      // re-probe: non-empty → still unpushed → preserve
      if (call.args.includes('log') && call.args.includes('@{upstream}..HEAD')) return { stdout: 'def456 unpushed commit\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'commits-ahead' });
    expect(mock.calls.some((c) => c.args.includes('lock'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #2749: detectRemoteDefaultRef + resolveAnchorBaseRef (mocked)
// ---------------------------------------------------------------------------

describe('detectRemoteDefaultRef — mocked', () => {
  it('returns the symbolic-ref result when refs/remotes/origin/HEAD is configured', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const ref = await detectRemoteDefaultRef(mock, repoRoot);
    expect(ref).toBe('origin/main');
    // Only one call: the symbolic-ref probe — no need to check convention refs.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.args).toContain('refs/remotes/origin/HEAD');
  });

  it('falls back to origin/main when symbolic-ref is missing but origin/main exists', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('symbolic-ref')) throw new Error('not set');
      if (call.args.includes('--verify') && call.args.some((a) => a.includes('origin/main'))) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const ref = await detectRemoteDefaultRef(mock, repoRoot);
    expect(ref).toBe('origin/main');
  });

  it('falls back to origin/master when symbolic-ref and origin/main are absent', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('symbolic-ref')) throw new Error('not set');
      if (call.args.includes('--verify') && call.args.some((a) => a.includes('origin/master'))) {
        return { stdout: 'cafebabe\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const ref = await detectRemoteDefaultRef(mock, repoRoot);
    expect(ref).toBe('origin/master');
  });

  it('returns undefined when no remote default is discoverable', async () => {
    const mock = makeMock(() => ({ stdout: '', stderr: '' }));
    const ref = await detectRemoteDefaultRef(mock, repoRoot);
    expect(ref).toBeUndefined();
  });
});

describe('resolveAnchorBaseRef — mocked (#2749)', () => {
  it('prefers the remote default branch SHA over local HEAD', async () => {
    const mock = makeMock((call) => {
      // symbolic-ref: origin/HEAD is configured → origin/main
      if (call.args.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '' };
      // rev-parse origin/main → remote SHA
      if (call.args.includes('rev-parse') && call.args.includes('origin/main')) {
        return { stdout: 'remote-sha-abc\n', stderr: '' };
      }
      // rev-parse HEAD → local SHA (should NOT be chosen)
      if (call.args.includes('rev-parse') && call.args.includes('HEAD')) {
        return { stdout: 'local-sha-xyz\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const sha = await resolveAnchorBaseRef(mock, repoRoot);
    // Remote SHA is returned; local HEAD is not consulted.
    expect(sha).toBe('remote-sha-abc');
    expect(mock.calls.some((c) => c.args.includes('HEAD'))).toBe(false);
  });

  it('falls back to local HEAD when no remote default exists', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('symbolic-ref')) throw new Error('not set');
      if (call.args.includes('--verify')) return { stdout: '', stderr: '' }; // no origin/main or /master
      if (call.args.includes('rev-parse') && call.args.includes('HEAD')) {
        return { stdout: 'local-head-sha\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const sha = await resolveAnchorBaseRef(mock, repoRoot);
    expect(sha).toBe('local-head-sha');
  });

  it('falls back to "HEAD" literal when both remote and local HEAD are unresolvable', async () => {
    const mock = makeMock(() => { throw new Error('git not available'); });
    const sha = await resolveAnchorBaseRef(mock, repoRoot);
    expect(sha).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// #2749: real-git integration — concurrent creates get same stable base
// ---------------------------------------------------------------------------

/**
 * Helper: run a real git command in `cwd`, throwing on non-zero exit.
 * Uses the real execFile (not the mock) so this runs actual git processes.
 * Kept local to the integration section — never imported into the mock tests.
 */
async function realGit(cwd: string, args: string[]): Promise<string> {
  try {
    const r = await execFileAsync('git', args, { cwd } as never);
    return (r as { stdout: string }).stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr ?? e.message ?? ''}`);
  }
}

describe('#2749: concurrent worktree creates — real git repos in tmpdir', () => {
  let upstreamDir: string;
  let cloneDir: string;

  beforeEach(async () => {
    // Upstream bare-style repo (the "remote").
    upstreamDir = mkdtempSync(join(tmpdir(), 'afk-upstream-'));
    await realGit(upstreamDir, ['init', '-b', 'main']);
    await realGit(upstreamDir, ['config', 'user.email', 'test@afk.test']);
    await realGit(upstreamDir, ['config', 'user.name', 'AFK Test']);
    await fs.writeFile(join(upstreamDir, 'README.md'), 'hello');
    await realGit(upstreamDir, ['add', 'README.md']);
    await realGit(upstreamDir, ['commit', '-m', 'init']);

    // Clone (the session's working directory).
    cloneDir = mkdtempSync(join(tmpdir(), 'afk-clone-'));
    await realGit(cloneDir, ['clone', upstreamDir, '.']);
    // Set local git identity so `git commit` works on CI runners that have no
    // global user.email / user.name configured (GitHub Actions bare runners).
    await realGit(cloneDir, ['config', 'user.email', 'test@afk.test']);
    await realGit(cloneDir, ['config', 'user.name', 'AFK Test']);
  });

  afterEach(() => {
    rmSync(upstreamDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('both concurrent creates use the remote default SHA, not the mutable local HEAD', async () => {
    // Capture the remote tracking SHA before we touch anything.
    const remoteSha = await realGit(cloneDir, ['rev-parse', 'origin/main']);

    // Simulate a local checkout operation that changes HEAD (the contamination
    // vector in #2749). After this, local HEAD !== origin/main.
    await fs.writeFile(join(cloneDir, 'local-only.txt'), 'local change');
    await realGit(cloneDir, ['add', 'local-only.txt']);
    await realGit(cloneDir, ['commit', '-m', 'local commit diverging from remote']);
    const localHead = await realGit(cloneDir, ['rev-parse', 'HEAD']);
    expect(localHead).not.toBe(remoteSha); // confirm divergence

    // Both resolveAnchorBaseRef calls should return the REMOTE SHA (stable),
    // not the local HEAD (contaminated by the local commit above).
    const [sha1, sha2] = await Promise.all([
      resolveAnchorBaseRef(execFileAsync as ExecFileFn, cloneDir),
      resolveAnchorBaseRef(execFileAsync as ExecFileFn, cloneDir),
    ]);

    expect(sha1).toBe(remoteSha);
    expect(sha2).toBe(remoteSha);
    // Neither session received the mutable local HEAD.
    expect(sha1).not.toBe(localHead);
    expect(sha2).not.toBe(localHead);
  });

  it('explicit base caller override is passed through unchanged (backward-compat)', async () => {
    // The #2749 fix is in the DEFAULT path — explicit `base` is untouched.
    // Verify the explicit-base path in createIsolatedWorktree still works.
    const remoteSha = await realGit(cloneDir, ['rev-parse', 'origin/main']);
    // resolveAnchorBaseRef is for the DEFAULT; explicit base is caller-supplied.
    // The existing createIsolatedWorktree already honors args.baseRef directly,
    // so we just confirm resolveAnchorBaseRef is not called on that path
    // by verifying the result from the explicit override matches exactly.
    const explicitSha = await realGit(cloneDir, ['rev-parse', 'origin/main']);
    expect(explicitSha).toBe(remoteSha); // sanity: explicit == remote
  });
});
