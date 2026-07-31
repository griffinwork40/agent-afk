/**
 * Tests for the worktree sweep engine.
 *
 * Strategy: dependency-injected `execFile` mock for git invocations; real
 * `node:fs` against a tmpdir for filesystem operations. Each describe block
 * corresponds to a distinct classification / behavioral scenario.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from './worktree-sweep.js';
import type { ExecFileFn } from './worktree-sweep.js';
import type { PresenceRecord } from './awareness/presence.js';

type ExecResult = { stdout: string; stderr: string };
type ExecCall = { file: string; args: string[]; opts?: { cwd?: string } };
type ExecHandler = (call: ExecCall) => Promise<ExecResult>;

interface MockExecFile {
  (file: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  calls: ExecCall[];
}

function makeMock(handler: ExecHandler): MockExecFile {
  const calls: ExecCall[] = [];
  const fn = ((file: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, opts });
    return handler({ file, args, opts });
  }) as MockExecFile;
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a git worktree list --porcelain output block */
function worktreeBlock(opts: {
  path: string;
  head?: string;
  branch?: string;
  locked?: boolean;
  prunable?: boolean;
  isBare?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`worktree ${opts.path}`);
  lines.push(`HEAD ${opts.head ?? 'abc1234abc1234abc1234abc1234abc1234abc1234'}`);
  if (opts.isBare) {
    lines.push('bare');
  } else {
    lines.push(`branch ${opts.branch ?? 'refs/heads/afk/test-branch'}`);
  }
  if (opts.locked) lines.push('locked');
  if (opts.prunable) lines.push('prunable');
  return lines.join('\n');
}

/** Write a telemetry JSONL file with N prior worktree-prune success records */
function writeFakeTelemetry(path: string, count: number, status = 'success'): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        taskId: 'worktree-prune',
        status,
        triggeredAt: new Date().toISOString(),
      }),
    );
  }
  writeFileSync(path, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let repoRoot: string;
let afkWorktreesDir: string;
let telemetryFile: string;
let lockFile: string;
let prevAfkHome: string | undefined;

beforeEach(async () => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-sweep-test-')));
  prevAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = repoRoot;
  afkWorktreesDir = join(repoRoot, '.afk-worktrees');
  await fs.mkdir(afkWorktreesDir, { recursive: true });
  telemetryFile = join(repoRoot, 'fake-telemetry.jsonl');
  // Per-test advisory-lock path under the unique mkdtemp repoRoot, injected
  // into every runSweep() call below. Without this, the engine falls back to
  // the single machine-global getWorktreeSweepLockPath(), and concurrent
  // vitest processes (CI runs sharing a self-hosted runner) contend that one
  // lock — the loser short-circuits with LockContestedError and returns an
  // empty result, which is the root cause this suite used to flake on.
  lockFile = join(repoRoot, 'sweep.lock');
  // Write 3 prior runs so soft-launch valve is satisfied by default
  writeFakeTelemetry(telemetryFile, 3);
});

afterEach(() => {
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
  if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevAfkHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. empty-detection
// ---------------------------------------------------------------------------

describe('empty-detection', () => {
  it('classifies a worktree with no commits and no dirty files as empty', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-empty-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    // Write meta so it passes scope filter
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123', baseBranch: 'main' }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wt1Block = worktreeBlock({ path: worktreePath, head: 'base123', branch: 'refs/heads/afk/empty-wt' });
    const porcelainOut = `${mainBlock}\n\n${wt1Block}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      if (args.includes('worktree') && args.includes('remove')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('branch') && args.includes('-d')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const emptyCandidates = result.candidates.filter((c) => c.verdict === 'empty');
    expect(emptyCandidates.length).toBe(1);
    expect(emptyCandidates[0]?.path).toBe(worktreePath);
    expect(result.removed).toContain(worktreePath);
    expect(result.dryRun).toBe(false);
  });

  // #759: bare `status --porcelain` never lists IGNORED files, so a tree whose
  // only content is ignored read CLEAN and every removal path runs
  // `remove --force`, deleting it. Committed work survives (branch refs live in
  // the shared .git) but worktree-local `.env`/scratch state does not.
  it('does NOT reap a clean tree holding a non-rebuildable ignored file (.env)', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-has-dotenv');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123', baseBranch: 'main' }),
    );

    const porcelainOut =
      `${worktreeBlock({ path: repoRoot, head: 'base123' })}\n\n` +
      `${worktreeBlock({ path: worktreePath, head: 'base123', branch: 'refs/heads/afk/has-dotenv' })}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      // The ignored-aware probe is a DIFFERENT call than the bare dirty check.
      if (args.includes('status') && args.includes('--ignored')) {
        return { stdout: '!! .env\n!! node_modules/\n', stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // tracked tree is clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.some((c) => c.verdict === 'empty')).toBe(false);
    expect(result.removed).not.toContain(worktreePath);
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  // The counterweight: if ANY ignored entry were protective, node_modules/ and
  // dist/ would make every worktree immortal and the sweep would never reclaim.
  it('still reaps a clean tree whose only ignored content is rebuildable output', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-only-build-output');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123', baseBranch: 'main' }),
    );

    const porcelainOut =
      `${worktreeBlock({ path: repoRoot, head: 'base123' })}\n\n` +
      `${worktreeBlock({ path: worktreePath, head: 'base123', branch: 'refs/heads/afk/only-build-output' })}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--ignored')) {
        return { stdout: '!! node_modules/\n!! dist/\n!! coverage/\n!! tsconfig.tsbuildinfo\n', stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.some((c) => c.verdict === 'empty')).toBe(true);
    expect(result.removed).toContain(worktreePath);
    // Discriminates this test from pre-existing clean+0-ahead+old => `empty`
    // behaviour: without this, hardcoding `hasNonRebuildableIgnoredFiles` to
    // always return `false` still passes, because nothing here proves the
    // probe ran at all. Assert the `--ignored` call actually happened.
    expect(mock.calls.some((c) => c.args.includes('status') && c.args.includes('--ignored'))).toBe(true);
  });

  it('does not remove empty worktree in dry-run mode', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-empty-dry');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123' }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: true,
      telemetryPath: telemetryFile,
    });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toHaveLength(0);
    expect(result.candidates.some((c) => c.verdict === 'empty')).toBe(true);
    // No worktree remove call
    const removeCalls = mock.calls.filter(
      (c) => c.args.includes('remove') || c.args.includes('prune'),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it('classifies a freshly-created empty worktree as active (min-age guard)', async () => {
    // Regression: prior behavior reaped a worktree created seconds before
    // the daemon's cron tick. The MIN_EMPTY_AGE_MS=1h guard now defers that.
    const worktreePath = join(afkWorktreesDir, 'afk-fresh-empty');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute old
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/fresh',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const freshCandidate = result.candidates.find((c) => c.path === worktreePath);
    expect(freshCandidate?.verdict).toBe('active');
    expect(result.removed).not.toContain(worktreePath);
    // No destructive git calls against the fresh worktree
    const removeCalls = mock.calls.filter(
      (c) =>
        c.args.includes('remove') &&
        c.args.includes('--force') &&
        c.args.includes(worktreePath),
    );
    expect(removeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. stale-clean-preserves-worktree
// ---------------------------------------------------------------------------

describe('stale-clean-preserves-worktree', () => {
  it('preserves a stale clean worktree with commits ahead and warns instead of removing', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-stale-clean');
    await fs.mkdir(worktreePath, { recursive: true });
    // 20 days old — past the 14-day clean threshold
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(),
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'tip456', branch: 'refs/heads/afk/stale-clean' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '3\n', stderr: '' }; // 3 commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      maxAgeDaysClean: 14,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.some((c) => c.verdict === 'stale-clean')).toBe(true);
    // Invariant: stale-clean only fires on trees with commits ahead of base
    // (clean + 0-ahead is always classified `empty` first), so removal here
    // would exclusively destroy committed-but-unmerged work. The sweep must
    // preserve the worktree and surface a warning instead.
    expect(result.removed).not.toContain(worktreePath);
    expect(
      result.warnings.some((w) => w.includes('stale-clean') && w.includes(worktreePath)),
    ).toBe(true);

    // No destructive git calls against the stale-clean worktree.
    const removeCalls = mock.calls.filter(
      (c) => c.args.includes('remove') && c.args.includes(worktreePath),
    );
    expect(removeCalls).toHaveLength(0);
    const branchDeleteCalls = mock.calls.filter(
      (c) => c.args.includes('branch') && c.args.includes('-d'),
    );
    expect(branchDeleteCalls).toHaveLength(0);
  });

  it('does not classify fresh zero-ahead clean worktrees as stale-clean when clean threshold is zero', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-fresh-zero-ahead');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/fresh-zero-ahead',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      maxAgeDaysClean: 0,
      telemetryPath: telemetryFile,
    });

    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).toBe('active');
    expect(result.removed).not.toContain(worktreePath);
    expect(result.warnings.some((w) => w.includes('stale-clean'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. stale-dirty-never-removes
// ---------------------------------------------------------------------------

describe('stale-dirty-never-removes', () => {
  it('never removes a dirty worktree, even when old, and warns instead', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-dirty-old');
    await fs.mkdir(worktreePath, { recursive: true });
    // 40 days old — past the 30-day dirty threshold
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 86_400_000 * 40).toISOString(),
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'tip456' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: 'M  file.ts\n', stderr: '' }; // dirty
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      maxAgeDaysDirty: 30,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.some((c) => c.verdict === 'stale-dirty')).toBe(true);
    expect(result.removed).not.toContain(worktreePath);
    expect(result.warnings.some((w) => w.includes('stale-dirty') || w.includes(worktreePath))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. locked-always-skipped
// ---------------------------------------------------------------------------

describe('locked-always-skipped', () => {
  it('never removes or warns about a locked worktree', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-locked-wt');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 50).toISOString() }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'abc123', locked: true });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.some((c) => c.verdict === 'locked')).toBe(true);
    expect(result.removed).not.toContain(worktreePath);
    // No error warnings about the locked worktree
    const errorWarnings = result.warnings.filter((w) => w.startsWith('[ERROR]'));
    expect(errorWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. orphaned-dir-cleanup
// ---------------------------------------------------------------------------

describe('orphaned-dir-cleanup', () => {
  it('detects and removes directories in .afk-worktrees/ not registered in git', async () => {
    // Create an orphaned directory under .afk-worktrees/
    const orphanPath = join(afkWorktreesDir, 'afk-orphaned-dir');
    await fs.mkdir(orphanPath, { recursive: true });
    await fs.writeFile(join(orphanPath, 'somefile.txt'), 'content');

    // Git worktree list does NOT include this directory
    const mainBlock = worktreeBlock({ path: repoRoot });
    const porcelainOut = `${mainBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const fsSpy = vi.spyOn(fs, 'rm');

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.some((c) => c.verdict === 'orphaned-dir')).toBe(true);
    expect(result.removed).toContain(orphanPath);
    expect(fsSpy).toHaveBeenCalledWith(orphanPath, { recursive: true, force: true });
  });

  it('does not remove orphaned dir in dry-run mode', async () => {
    const orphanPath = join(afkWorktreesDir, 'afk-orphan-dry');
    await fs.mkdir(orphanPath, { recursive: true });

    const mainBlock = worktreeBlock({ path: repoRoot });
    const porcelainOut = `${mainBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: true,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.some((c) => c.verdict === 'orphaned-dir')).toBe(true);
    expect(result.removed).not.toContain(orphanPath);
    // Directory should still exist
    const exists = await fs.stat(orphanPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. orphaned-registration-prune
// ---------------------------------------------------------------------------

describe('orphaned-registration-prune', () => {
  it('calls git worktree prune exactly once even with multiple orphaned registrations', async () => {
    // Two paths that appear in git list but don't exist on disk
    const ghost1 = join(afkWorktreesDir, 'afk-ghost-1');
    const ghost2 = join(afkWorktreesDir, 'afk-ghost-2');

    const mainBlock = worktreeBlock({ path: repoRoot });
    const ghost1Block = worktreeBlock({ path: ghost1, head: 'aaa111' });
    const ghost2Block = worktreeBlock({ path: ghost2, head: 'bbb222' });
    const porcelainOut = `${mainBlock}\n\n${ghost1Block}\n\n${ghost2Block}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    // Both should appear as orphaned-registration
    const orphanReg = result.candidates.filter((c) => c.verdict === 'orphaned-registration');
    expect(orphanReg).toHaveLength(2);

    // git worktree prune should be called exactly once
    const pruneCalls = mock.calls.filter(
      (c) => c.args.includes('worktree') && c.args.includes('prune') && !c.args.includes('list'),
    );
    expect(pruneCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. base-sha-fallback
// ---------------------------------------------------------------------------

describe('base-sha-fallback', () => {
  it('classifies correctly without .afk-worktree-meta.json present', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-no-meta');
    await fs.mkdir(worktreePath, { recursive: true });
    // No meta file written

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' }); // same SHA as base
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    // Should not throw
    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: true,
      telemetryPath: telemetryFile,
    });

    // Should classify as something valid
    expect(result.candidates.length).toBeGreaterThan(0);
    const verdict = result.candidates[0]?.verdict;
    expect(['empty', 'stale-clean', 'stale-dirty', 'active', 'locked']).toContain(verdict);
  });

  it('preserves a baseSha-less worktree that holds unmerged commits (counts against main HEAD, not self)', async () => {
    // Regression guard: a meta with no `baseSha` (exactly what
    // touchWorktreeOccupancy writes when it adopts a hand-created
    // `git worktree add` tree) must NOT self-compare its HEAD to itself —
    // that always yields 0 commits ahead and makes a tree holding real
    // unmerged work look `empty`, force-removing the checkout.
    const worktreePath = join(afkWorktreesDir, 'afk-nobase-ahead');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), // 2h old
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'mainsha111' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'wtsha222', // differs from main HEAD
      branch: 'refs/heads/afk/nobase-ahead',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.some((a) => a.includes('@{upstream}'))) {
        // Model real git: this branch has no configured upstream, so
        // `rev-list @{upstream}..HEAD` exits non-zero. The sweep must fail
        // safe here and keep commitsUnpushed === commitsAhead, preserving the
        // tree. Matched BEFORE the generic rev-list branch below, which would
        // otherwise answer this query with the base-comparison count.
        throw new Error("fatal: no upstream configured for branch 'afk/nobase-ahead'");
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        // The fix counts commits reachable from the worktree HEAD but NOT from
        // main (`--not`). The old self-comparing fallback (base === head) would
        // instead resolve to 0 here and misclassify the tree as empty.
        return args.includes('--not')
          ? { stdout: '2\n', stderr: '' }
          : { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const verdict = result.candidates.find((c) => c.path === worktreePath)?.verdict;
    expect(verdict).not.toBe('empty');
    expect(verdict).not.toBe('dead-owner');
    expect(result.removed).not.toContain(worktreePath);
  });

  it('still reaps a baseSha-less worktree with no commits (sitting at main HEAD)', async () => {
    // Complement of the previous test: the fallback must not over-preserve.
    // A baseSha-less tree that sits at main's HEAD is genuinely empty and
    // remains reapable.
    const worktreePath = join(afkWorktreesDir, 'afk-nobase-empty');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), // 2h old
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'samesha000' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'samesha000', // identical to main HEAD → nothing ahead
      branch: 'refs/heads/afk/nobase-empty',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const verdict = result.candidates.find((c) => c.path === worktreePath)?.verdict;
    expect(verdict).toBe('empty');
    expect(result.removed).toContain(worktreePath);
  });
});

// ---------------------------------------------------------------------------
// 8. dry-run-zero-side-effects
// ---------------------------------------------------------------------------

describe('dry-run-zero-side-effects', () => {
  it('makes no mutations in dry-run mode', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-dry-run-check');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(),
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: true,
      telemetryPath: telemetryFile,
    });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toHaveLength(0);

    // No remove, prune, or branch -d calls
    const mutatingCalls = mock.calls.filter(
      (c) =>
        c.args.includes('remove') ||
        (c.args.includes('prune') && !c.args.includes('list')) ||
        c.args.includes('-d'),
    );
    expect(mutatingCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. soft-launch-valve
// ---------------------------------------------------------------------------

describe('soft-launch-valve', () => {
  it('forces dry-run when fewer than 3 prior successful runs (0 runs)', async () => {
    const emptyTelemetry = join(repoRoot, 'empty-telemetry.jsonl');
    writeFakeTelemetry(emptyTelemetry, 0);

    const worktreePath = join(afkWorktreesDir, 'afk-valve-test');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123' }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false, // requested live — valve should override
      telemetryPath: emptyTelemetry,
    });

    expect(result.dryRun).toBe(true); // forced by valve
    expect(result.removed).toHaveLength(0);
  });

  it('forces dry-run with 2 prior runs (below threshold)', async () => {
    const twoRunTelemetry = join(repoRoot, 'two-run-telemetry.jsonl');
    writeFakeTelemetry(twoRunTelemetry, 2);

    const worktreePath = join(afkWorktreesDir, 'afk-valve-2');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123' }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: twoRunTelemetry,
    });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toHaveLength(0);
  });

  it('executes live (non-dry-run) with 3 or more prior successful runs', async () => {
    const threeRunTelemetry = join(repoRoot, 'three-run-telemetry.jsonl');
    writeFakeTelemetry(threeRunTelemetry, 3);

    const worktreePath = join(afkWorktreesDir, 'afk-valve-live');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123' }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      if (args.includes('remove') || args.includes('branch')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: threeRunTelemetry,
    });

    expect(result.dryRun).toBe(false); // valve satisfied — live run
  });

  it('counts only worktree-prune success/error records, not skipped', async () => {
    const mixedTelemetry = join(repoRoot, 'mixed-telemetry.jsonl');
    // 2 success + 2 skipped — skipped should not count
    const lines = [
      JSON.stringify({ taskId: 'worktree-prune', status: 'success', triggeredAt: new Date().toISOString() }),
      JSON.stringify({ taskId: 'worktree-prune', status: 'skipped', triggeredAt: new Date().toISOString() }),
      JSON.stringify({ taskId: 'worktree-prune', status: 'success', triggeredAt: new Date().toISOString() }),
      JSON.stringify({ taskId: 'worktree-prune', status: 'skipped', triggeredAt: new Date().toISOString() }),
      // Other task — should not count
      JSON.stringify({ taskId: 'other-task', status: 'success', triggeredAt: new Date().toISOString() }),
    ];
    writeFileSync(mixedTelemetry, lines.join('\n') + '\n');

    const worktreePath = join(afkWorktreesDir, 'afk-valve-mixed');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), baseSha: 'base123' }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) return { stdout: porcelainOut, stderr: '' };
      if (args.includes('status')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    // 2 success records — below threshold of 3 → should still be dry-run
    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: mixedTelemetry,
    });

    expect(result.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. advisory-lock-contention
// ---------------------------------------------------------------------------

describe('advisory-lock-contention', () => {
  it('returns warning and empty removed list when lock is contested with live PID', async () => {
    // Contend the test-isolated lock (lockFile), not the machine-global one,
    // so this assertion is deterministic under concurrent vitest processes.
    const lockPath = lockFile;

    // Ensure directory exists
    await fs.mkdir(join(lockPath, '..'), { recursive: true }).catch(() => {});

    // Write our own PID — this process is definitely alive
    await fs.writeFile(lockPath, String(process.pid), 'utf-8');

    const mock = makeMock(async () => ({ stdout: '', stderr: '' }));

    try {
      const result = await runSweep({
        execFile: mock as ExecFileFn,
        repoRoot,
        lockPath: lockFile,
        dryRun: false,
        telemetryPath: telemetryFile,
      });

      // Should not throw — returns gracefully with a warning
      expect(result.removed).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      const hasLockWarning = result.warnings.some(
        (w) => w.toLowerCase().includes('lock') || w.toLowerCase().includes('contested'),
      );
      expect(hasLockWarning).toBe(true);
    } finally {
      // Clean up the lock file we created
      await fs.unlink(lockPath).catch(() => {});
    }
  });

  it('recovers from a stale lock (dead PID)', async () => {
    const lockPath = lockFile;

    await fs.mkdir(join(lockPath, '..'), { recursive: true }).catch(() => {});

    // Write a non-existent PID (99999999 is almost certainly not running)
    await fs.writeFile(lockPath, '99999999', 'utf-8');

    const mainBlock = worktreeBlock({ path: repoRoot });
    const porcelainOut = `${mainBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      // Should succeed by detecting stale PID and recovering
      const result = await runSweep({
        execFile: mock as ExecFileFn,
        repoRoot,
        lockPath: lockFile,
        dryRun: true,
        telemetryPath: telemetryFile,
      });

      // No contested warning — stale lock was cleared
      const lockedWarnings = result.warnings.filter(
        (w) => w.toLowerCase().includes('contested'),
      );
      expect(lockedWarnings).toHaveLength(0);
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// 11. dead-owner — accelerated reaping of ghost worktrees
// ---------------------------------------------------------------------------

describe('dead-owner', () => {
  /**
   * Helper to find a PID that is guaranteed not to exist. We pick a large
   * value and verify the kernel agrees it's dead before using it. If the
   * first guess collides, we keep walking until we find one.
   */
  function findDeadPid(): number {
    for (let pid = 999_999; pid > 90_000; pid -= 1_117) {
      try {
        process.kill(pid, 0);
        // Process exists — not safe to use as "dead"
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return pid;
      }
    }
    throw new Error('Could not find a dead PID for test setup');
  }

  it('reaps a recent ghost worktree (clean tree, dead owner, age < empty threshold)', async () => {
    const deadPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-dead-recent');
    await fs.mkdir(worktreePath, { recursive: true });

    // 5 minutes old — way under MIN_EMPTY_AGE_MS (1h). Without dead-owner,
    // this would classify as 'active' and survive the sweep.
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/dead-recent',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(1);
    expect(deadOwnerCandidates[0]?.path).toBe(worktreePath);
    expect(result.removed).toContain(worktreePath);
  });

  it('preserves a dead-owner worktree with uncommitted changes', async () => {
    const deadPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-dead-dirty');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: ' M src/foo.ts\n', stderr: '' }; // dirty
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    // Dead PID + dirty → must NOT be dead-owner. Verdict falls through to
    // 'active' (age below stale-dirty threshold) and the tree is preserved.
    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(0);
    expect(result.removed).not.toContain(worktreePath);
  });

  it('preserves a dead-owner worktree with commits ahead of base', async () => {
    const deadPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-dead-ahead');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'newhead', branch: 'refs/heads/afk/dead-ahead' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '3\n', stderr: '' }; // 3 commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(0);
    expect(result.removed).not.toContain(worktreePath);
  });

  it('does not reap a worktree whose PID is alive (current process)', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-alive');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: process.pid, // alive — this test process
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(0);
    expect(result.removed).not.toContain(worktreePath);
  });

  it('ignores stale pid when meta is older than the PID-reuse safety window', async () => {
    // Use a PID we know is dead — but bury the meta well past 30 days. The
    // classifier must NOT trust the pid here (PID may have been reused),
    // and must fall through to the existing age-gated stale-clean path.
    const deadPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-old-pid');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadPid,
        createdAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), // 60d old
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123', branch: 'refs/heads/afk/old-pid' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    // 60d > MAX_TRUSTED_PID_AGE_MS (30d) → ownerLiveness collapses to
    // 'unknown' and dead-owner is NOT assigned. The tree is clean with
    // no commits ahead and age > MIN_EMPTY_AGE_MS, so the next classifier
    // arm catches it as 'empty'. The contract this test pins: a stale
    // PID inside a too-old meta MUST NOT short-circuit to dead-owner.
    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(0);
    const emptyCandidates = result.candidates.filter((c) => c.verdict === 'empty');
    expect(emptyCandidates).toHaveLength(1);
  });

  it('falls through to age-gated path when meta has no pid field', async () => {
    // Backward-compat: pre-PID worktrees lack the field entirely.
    const worktreePath = join(afkWorktreesDir, 'afk-no-pid');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5min
        baseSha: 'base123',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({ path: worktreePath, head: 'base123' });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    // 5min < MIN_EMPTY_AGE_MS (1h) → 'active', not removed.
    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(0);
    expect(result.removed).not.toContain(worktreePath);
    const activeCandidates = result.candidates.filter((c) => c.verdict === 'active');
    expect(activeCandidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 12. dead-owner — live-session protection
// ---------------------------------------------------------------------------

describe('dead-owner — live-session protection', () => {
  /**
   * Helper to find a PID that is guaranteed not to exist.
   */
  function findDeadPid(): number {
    for (let pid = 999_999; pid > 90_000; pid -= 1_117) {
      try {
        process.kill(pid, 0);
        // Process exists — not safe to use as "dead"
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return pid;
      }
    }
    throw new Error('Could not find a dead PID for test setup');
  }

  it('does NOT reap a dead-owner worktree while a live session occupies it', async () => {
    const deadPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-live-session-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/live-session-wt',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
      readPresence: async () => [{ pid: process.pid, cwd: worktreePath } as unknown as PresenceRecord],
    });

    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(0);
    expect(result.removed).not.toContain(worktreePath);
  });

  it('still reaps when the presence file is stale (its pid is dead)', async () => {
    const deadPid = findDeadPid();
    const stalePid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-stale-presence-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/stale-presence-wt',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
      readPresence: async () => [{ pid: stalePid, cwd: worktreePath } as unknown as PresenceRecord],
    });

    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(1);
    expect(result.removed).toContain(worktreePath);
  });

  it('still reaps when the live session cwd is outside the worktree', async () => {
    const deadPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-outside-cwd-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/outside-cwd-wt',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
      readPresence: async () => [{ pid: process.pid, cwd: join(repoRoot, 'somewhere-else') } as unknown as PresenceRecord],
    });

    const deadOwnerCandidates = result.candidates.filter((c) => c.verdict === 'dead-owner');
    expect(deadOwnerCandidates).toHaveLength(1);
    expect(result.removed).toContain(worktreePath);
  });

  it('end-to-end: REAL updatePresenceCwd flips the verdict from reap to spare', async () => {
    // Closes the seam the unit tests leave open: presence.test.ts covers the
    // updatePresenceCwd file round-trip in isolation, and agent-session.test.ts
    // asserts setCwd→updatePresenceCwd via a MOCK. Neither proves the on-disk
    // record updatePresenceCwd writes is consumed by the sweep's live-session
    // guard. This composes the REAL updatePresenceCwd write with the REAL
    // readPresenceFiles reader the daemon sweep uses by default.
    //
    // The worktree's creator pid is DEAD (and the meta is fresh, so it is not
    // 'unknown'), so the presence.cwd path is the ONLY thing that can spare it —
    // exactly the born-named `afk -w` scenario. dryRun keeps the worktree on
    // disk across both phases so the verdict flip is attributable solely to the
    // cwd write. AFK_HOME is set to repoRoot in beforeEach, so the real presence
    // dir is isolated to this test's tmpdir.
    const { writePresenceFile, updatePresenceCwd, readPresenceFiles } = await import('./awareness/presence.js');

    const deadOwnerPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-e2e-presence-wt');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadOwnerPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/e2e-presence-wt',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;
    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) return { stdout: porcelainOut, stderr: '' };
      if (args.includes('status') && args.includes('--porcelain')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list') && args.includes('--count')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    // dryRun:true keeps the worktree on disk so the same fixture is swept twice.
    // readPresence is the production default (readPresenceFiles), passed
    // explicitly so the intent — exercise the real on-disk read path — is clear.
    const sweepOpts = {
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: true,
      telemetryPath: telemetryFile,
      readPresence: readPresenceFiles,
    };

    // Turn 0: a live session writes presence with the LAUNCH dir. The born-named
    // worktree does not exist yet, so presence.cwd points at the host repo.
    const sessionId = 'e2e-presence-cwd';
    await writePresenceFile({
      sessionId,
      surface: 'cli',
      cwd: repoRoot, // stale launch dir, NOT the worktree
      startedAt: new Date().toISOString(),
      model: { provider: 'anthropic-direct', name: 'test-model' },
      workspace: { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null },
      pid: process.pid, // alive — this test process
    });

    // Phase 1 (pre-fix state): stale presence.cwd → guard can't match → reaped.
    const before = await runSweep(sweepOpts);
    expect(before.candidates.filter((c) => c.verdict === 'dead-owner')).toHaveLength(1);

    // Turn 1: the worktree is created and setCwd fires updatePresenceCwd.
    await updatePresenceCwd(sessionId, worktreePath);

    // Phase 2 (fixed state): presence.cwd now inside the worktree → spared.
    const after = await runSweep(sweepOpts);
    expect(after.candidates.filter((c) => c.verdict === 'dead-owner')).toHaveLength(0);
    expect(after.removed).not.toContain(worktreePath);
  });

  it('end-to-end: a REAL blockedSince write does not perturb the in-use guard', async () => {
    // The sweep decides whether a worktree is in use by reading presence records
    // (`readPresenceFiles` → `isPathWithin(presence.cwd, worktreePath)`), so it is
    // the safety-critical consumer of this file format: a record it fails to parse
    // is a worktree reaped out from under a live session. `blockedSince` is an
    // additive optional field, but "additive is safe" is exactly the assumption
    // that deserves a test rather than trust — presence-surface.test.ts exists
    // because a format change silently broke /watch.
    //
    // Composes the REAL setPresenceBlocked writer with the REAL readPresenceFiles
    // reader the daemon sweep uses, and asserts the spare verdict is invariant
    // across set → clear. The creator pid is DEAD, so presence.cwd is the ONLY
    // thing sparing this worktree: if a blocked write corrupted or dropped the
    // record, the verdict would flip straight back to 'dead-owner'.
    const { writePresenceFile, setPresenceBlocked, readPresenceFiles } = await import('./awareness/presence.js');

    const deadOwnerPid = findDeadPid();
    const worktreePath = join(afkWorktreesDir, 'afk-e2e-blocked-wt');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        pid: deadOwnerPid,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/e2e-blocked-wt',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;
    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) return { stdout: porcelainOut, stderr: '' };
      if (args.includes('status') && args.includes('--porcelain')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list') && args.includes('--count')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const sweepOpts = {
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: true,
      telemetryPath: telemetryFile,
      readPresence: readPresenceFiles,
    };

    const sessionId = 'e2e-presence-blocked';
    await writePresenceFile({
      sessionId,
      surface: 'cli',
      cwd: worktreePath, // live session working INSIDE the worktree
      startedAt: new Date().toISOString(),
      model: { provider: 'anthropic-direct', name: 'test-model' },
      workspace: { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null },
      pid: process.pid, // alive — this test process
    });

    // Baseline: live session inside the worktree → spared.
    const baseline = await runSweep(sweepOpts);
    expect(baseline.candidates.filter((c) => c.verdict === 'dead-owner')).toHaveLength(0);

    // Session blocks on a human (e.g. a path-approval prompt) → still spared.
    await setPresenceBlocked(sessionId, true);
    const blockedRec = (await readPresenceFiles()).find((r) => r.sessionId === sessionId);
    expect(blockedRec?.blockedSince).toBeDefined();
    expect(blockedRec?.cwd).toBe(worktreePath); // the guard's input survived the write
    const whileBlocked = await runSweep(sweepOpts);
    expect(whileBlocked.candidates.filter((c) => c.verdict === 'dead-owner')).toHaveLength(0);
    expect(whileBlocked.removed).not.toContain(worktreePath);

    // Operator answers → marker cleared, verdict unchanged.
    await setPresenceBlocked(sessionId, false);
    const afterClear = await runSweep(sweepOpts);
    expect(afterClear.candidates.filter((c) => c.verdict === 'dead-owner')).toHaveLength(0);
    expect(afterClear.removed).not.toContain(worktreePath);
  });
});

// ---------------------------------------------------------------------------
// 13. branch-delete short-name (#371)
// ---------------------------------------------------------------------------

describe('branch-delete short-name (#371)', () => {
  it('strips refs/heads/ before invoking git branch -d on an empty-verdict sweep', async () => {
    // Regression: `git worktree list --porcelain` reports `branch` as a
    // fully-qualified ref (refs/heads/afk/foo), but `git branch -d` wants
    // the short name (afk/foo). Passing the qualified ref always fails
    // ("branch 'refs/heads/afk/foo' not found"), silently swallowed by
    // `.catch(() => {})`, leaving the branch behind forever.
    const worktreePath = join(afkWorktreesDir, 'afk-branch-shortname-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 86_400_000 * 2).toISOString(), // 2 days old
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/foo',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      if (args.includes('worktree') && args.includes('remove')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('branch') && args.includes('-d')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    expect(result.candidates.find((c) => c.path === worktreePath)?.verdict).toBe('empty');
    expect(result.removed).toContain(worktreePath);

    const branchDeleteCalls = mock.calls.filter(
      (c) => c.file === 'git' && c.args.includes('branch') && c.args.includes('-d'),
    );
    expect(branchDeleteCalls).toHaveLength(1);
    expect(branchDeleteCalls[0]?.args).toContain('afk/foo');
    expect(branchDeleteCalls[0]?.args).not.toContain('refs/heads/afk/foo');
  });
});

// ---------------------------------------------------------------------------
// 14. empty-verdict liveness gate (#380)
// ---------------------------------------------------------------------------

describe('empty-verdict liveness gate (#380)', () => {
  it('does NOT classify an otherwise-empty worktree as empty while a live session occupies it', async () => {
    // Regression: the `empty` verdict never checked ownerLiveness, so the
    // live-session presence guard (which forces ownerLiveness to 'alive'
    // when a live session's cwd is inside the worktree) only ever protected
    // the `dead-owner` verdict. A live session's clean, 0-commits-ahead
    // worktree older than MIN_EMPTY_AGE_MS still classified as `empty` and
    // got reaped mid-session.
    const worktreePath = join(afkWorktreesDir, 'afk-empty-live-session-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    // No `pid` in meta -> ownerLiveness starts 'unknown'. Absent the
    // live-session guard, this worktree is squarely 'empty'-eligible: clean,
    // 0 commits ahead, and well past MIN_EMPTY_AGE_MS (1h).
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 86_400_000 * 2).toISOString(), // 2 days old
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/empty-live-session-wt',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // no commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
      readPresence: async () => [{ pid: process.pid, cwd: worktreePath } as unknown as PresenceRecord],
    });

    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).not.toBe('empty');
    expect(candidate?.verdict).toBe('active');
    expect(result.removed).not.toContain(worktreePath);

    // No destructive git calls fired against this worktree.
    const removeCalls = mock.calls.filter(
      (c) => c.args.includes('remove') && c.args.includes('--force') && c.args.includes(worktreePath),
    );
    expect(removeCalls).toHaveLength(0);
  });

  /**
   * Invariant: what actually protects a worktree hosting a running subagent is
   * the LIVE PID stamped by `touchWorktreeOccupancy`, not the age gate. A
   * forked subagent runs in this same OS process, so `ownerLiveness` resolves
   * 'alive' for its whole run and `empty` — which requires
   * `ownerLiveness !== 'alive'` — is unreachable however old the tree gets.
   *
   * These two cases pin that relationship in the direction the occupancy
   * heartbeat depends on. Without them the heartbeat's rationale is untestable
   * prose: nothing failed when the module docblock claimed a live child "ages
   * back into the `empty` verdict", because no test drove the heartbeat's
   * effect through `runSweep` at all.
   */
  it('never reaps a clean tree whose meta carries a live pid, however old', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-live-pid-old-wt');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        pid: process.pid, // alive — exactly what touchWorktreeOccupancy stamps
        createdAt: new Date(Date.now() - 86_400_000 * 7).toISOString(), // 7d ≫ 1h gate
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/live-pid-old-wt',
    });
    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: `${mainBlock}\n\n${wtBlock}\n`, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
      readPresence: async () => [],
    });

    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).not.toBe('empty');
    expect(candidate?.verdict).not.toBe('dead-owner');
    expect(result.removed).not.toContain(worktreePath);
  });

  it('DOES reap an aged clean tree whose meta has no pid — the state the heartbeat defends', async () => {
    const worktreePath = join(afkWorktreesDir, 'afk-no-pid-old-wt');
    await fs.mkdir(worktreePath, { recursive: true });
    // No `pid`: the stamp never landed, or the meta was written by something
    // else. ownerLiveness → 'unknown', so MIN_EMPTY_AGE_MS is the only guard —
    // which is precisely why the heartbeat keeps re-asserting `createdAt`.
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        createdAt: new Date(Date.now() - 86_400_000 * 7).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/no-pid-old-wt',
    });
    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: `${mainBlock}\n\n${wtBlock}\n`, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: true, // classification only — no filesystem mutation needed
      telemetryPath: telemetryFile,
      readPresence: async () => [],
    });

    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// 15. stale-clean liveness guard (Codex P2 on PR #432)
// ---------------------------------------------------------------------------

describe('stale-clean liveness guard (Codex review, PR #432)', () => {
  it('does not classify an old, zero-ahead, clean worktree occupied by a live session as stale-clean', async () => {
    // Regression: Codex flagged that the #380 empty-verdict liveness guard
    // above only skips the `empty` verdict for non-'alive'-owned candidates —
    // a live-owned candidate that is also older than maxAgeDaysClean falls
    // through to the next checks. Against the commit Codex reviewed
    // (033e4ff51f), `stale-clean` tested only `!isDirty && ageMs >
    // cleanThresholdMs` with no commits-ahead guard, so a live session's
    // clean, 0-commits-ahead worktree past the clean threshold would
    // misclassify as `stale-clean` and emit a misleading "commits ahead of
    // base" warning instead of staying `active`. `stale-clean` has since
    // required `commitsAhead > 0` (#429), which independently closes this
    // gap — but that fix was never pinned against the specific live-session +
    // old-age combination Codex called out. This test locks that combination
    // down so a future regression on either guard trips here.
    const worktreePath = join(afkWorktreesDir, 'afk-stale-clean-live-session');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'interactive',
        createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(), // 20 days old, past 14-day clean threshold
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const mainBlock = worktreeBlock({ path: repoRoot, head: 'base123' });
    const wtBlock = worktreeBlock({
      path: worktreePath,
      head: 'base123',
      branch: 'refs/heads/afk/stale-clean-live-session',
    });
    const porcelainOut = `${mainBlock}\n\n${wtBlock}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: '0\n', stderr: '' }; // 0 commits ahead
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      maxAgeDaysClean: 14,
      telemetryPath: telemetryFile,
      readPresence: async () => [{ pid: process.pid, cwd: worktreePath } as unknown as PresenceRecord],
    });

    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).toBe('active');
    expect(candidate?.verdict).not.toBe('stale-clean');
    expect(result.removed).not.toContain(worktreePath);
    expect(
      result.warnings.some((w) => w.includes('stale-clean') && w.includes(worktreePath)),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pushed-commits reaping — a shipped worktree stops being sacred
// ---------------------------------------------------------------------------

describe('pushed-commits reaping', () => {
  /** A PID the kernel agrees does not exist, so ownerLiveness resolves 'dead'. */
  function findDeadPid(): number {
    for (let pid = 999_999; pid > 90_000; pid -= 1_117) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      }
    }
    throw new Error('Could not find a dead PID for test setup');
  }

  /**
   * Build a sweep fixture for a clean worktree holding `commitsAhead` commits
   * past its recorded base, of which `unpushed` are not on the remote.
   * `unpushed: 'no-upstream'` models a branch with no tracking ref, where real
   * git exits non-zero on `rev-list @{upstream}..HEAD`.
   */
  async function fixture(opts: {
    name: string;
    ageMs: number;
    pid?: number;
    commitsAhead: number;
    unpushed: number | 'no-upstream';
  }) {
    const worktreePath = join(afkWorktreesDir, opts.name);
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
        createdAt: new Date(Date.now() - opts.ageMs).toISOString(),
        baseSha: 'basesha000',
      }),
    );

    const porcelainOut =
      `${worktreeBlock({ path: repoRoot, head: 'mainsha111' })}\n\n` +
      `${worktreeBlock({
        path: worktreePath,
        head: 'wtsha222',
        branch: `refs/heads/afk/${opts.name}`,
      })}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) {
        return { stdout: porcelainOut, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // clean
      }
      if (args.includes('rev-list') && args.some((a) => a.includes('@{upstream}'))) {
        if (opts.unpushed === 'no-upstream') {
          throw new Error('fatal: no upstream configured for branch');
        }
        return { stdout: `${opts.unpushed}\n`, stderr: '' };
      }
      if (args.includes('rev-list') && args.includes('--count')) {
        return { stdout: `${opts.commitsAhead}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    return { worktreePath, mock };
  }

  it('reaps a clean worktree whose commits are all pushed (dead owner)', async () => {
    // The /ship case: work committed, branch pushed, PR opened, session died.
    // The commits live on the remote and `git worktree remove` preserves the
    // branch ref, so the checkout is disposable.
    const { worktreePath, mock } = await fixture({
      name: 'afk-shipped',
      ageMs: 5 * 60_000,
      pid: findDeadPid(),
      commitsAhead: 3,
      unpushed: 0,
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const verdict = result.candidates.find((c) => c.path === worktreePath)?.verdict;
    expect(verdict).toBe('dead-owner');
    expect(result.removed).toContain(worktreePath);
  });

  it('reaps a clean fully-pushed worktree past the empty age gate (no pid)', async () => {
    const { worktreePath, mock } = await fixture({
      name: 'afk-shipped-old',
      ageMs: 3 * 3_600_000, // 3h — past MIN_EMPTY_AGE_MS
      commitsAhead: 2,
      unpushed: 0,
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const verdict = result.candidates.find((c) => c.path === worktreePath)?.verdict;
    expect(verdict).toBe('empty');
    expect(result.removed).toContain(worktreePath);
  });

  it('NEVER runs `git branch -d` when reaping a pushed worktree', async () => {
    // Regression guard for the hole found in review: `git branch -d` deletes a
    // branch that is merged to its UPSTREAM, which is exactly the state a
    // pushed worktree is in. Verified against real git: it exits 0 with
    // "merged to refs/remotes/origin/X, but not yet merged to HEAD". If the
    // remote branch is later deleted and the tracking ref pruned, those commits
    // become reachable from nothing. The branch ref is the last copy — keep it.
    const { worktreePath, mock } = await fixture({
      name: 'afk-shipped-keepbranch',
      ageMs: 5 * 60_000,
      pid: findDeadPid(),
      commitsAhead: 3,
      unpushed: 0,
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    expect(result.removed).toContain(worktreePath);
    const branchDeletes = mock.calls.filter(
      (c) => c.args.includes('branch') && c.args.includes('-d'),
    );
    expect(branchDeletes).toHaveLength(0);
    // ...and the operator is told the branch survived, so the reap is legible.
    expect(
      result.warnings.some(
        (w) => w.includes('branch preserved') && w.includes(worktreePath),
      ),
    ).toBe(true);
  });

  it('still deletes the branch when the reaped tree had no commits at all', async () => {
    // The pre-existing behavior must not regress: a genuinely empty tree's
    // throwaway branch is still cleaned up.
    const { worktreePath, mock } = await fixture({
      name: 'afk-truly-empty',
      ageMs: 5 * 60_000,
      pid: findDeadPid(),
      commitsAhead: 0,
      unpushed: 0,
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    expect(result.removed).toContain(worktreePath);
    const branchDeletes = mock.calls.filter(
      (c) => c.args.includes('branch') && c.args.includes('-d'),
    );
    expect(branchDeletes.length).toBeGreaterThan(0);
  });

  it('PRESERVES a worktree with unpushed commits (dead owner)', async () => {
    // The guard that must not regress: one unpushed commit means this checkout
    // is the only place that work exists.
    const { worktreePath, mock } = await fixture({
      name: 'afk-unpushed',
      ageMs: 5 * 60_000,
      pid: findDeadPid(),
      commitsAhead: 3,
      unpushed: 1,
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const verdict = result.candidates.find((c) => c.path === worktreePath)?.verdict;
    expect(verdict).not.toBe('dead-owner');
    expect(verdict).not.toBe('empty');
    expect(result.removed).not.toContain(worktreePath);
  });

  it('PRESERVES a worktree with no upstream configured (fail-safe)', async () => {
    // Any failure reading the upstream must leave commitsUnpushed at
    // commitsAhead, reproducing pre-change behavior exactly.
    const { worktreePath, mock } = await fixture({
      name: 'afk-no-upstream',
      ageMs: 3 * 3_600_000,
      pid: findDeadPid(),
      commitsAhead: 4,
      unpushed: 'no-upstream',
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const verdict = result.candidates.find((c) => c.path === worktreePath)?.verdict;
    expect(verdict).not.toBe('dead-owner');
    expect(verdict).not.toBe('empty');
    expect(result.removed).not.toContain(worktreePath);
  });

  it('never reaps a fully-pushed worktree that a live session is using', async () => {
    // Liveness beats disposability: a pushed tree in active use stays.
    const { worktreePath, mock } = await fixture({
      name: 'afk-shipped-live',
      ageMs: 3 * 3_600_000,
      pid: process.pid, // alive
      commitsAhead: 2,
      unpushed: 0,
    });

    const result = await runSweep({
      execFile: mock as ExecFileFn,
      repoRoot,
      lockPath: lockFile,
      dryRun: false,
      telemetryPath: telemetryFile,
    });

    const verdict = result.candidates.find((c) => c.path === worktreePath)?.verdict;
    expect(verdict).not.toBe('dead-owner');
    expect(verdict).not.toBe('empty');
    expect(result.removed).not.toContain(worktreePath);
  });
});
