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

beforeEach(async () => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-sweep-test-')));
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
// 2. stale-clean-preserves-branch
// ---------------------------------------------------------------------------

describe('stale-clean-preserves-branch', () => {
  it('removes stale clean worktree via worktree remove but does NOT delete branch', async () => {
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
    expect(result.removed).toContain(worktreePath);

    // worktree remove --force should be called
    const removeCalls = mock.calls.filter(
      (c) => c.args.includes('remove') && c.args.includes('--force'),
    );
    expect(removeCalls.length).toBeGreaterThan(0);

    // branch -d should NOT be called (branch preserved for stale-clean)
    const branchDeleteCalls = mock.calls.filter(
      (c) => c.args.includes('branch') && c.args.includes('-d'),
    );
    expect(branchDeleteCalls).toHaveLength(0);
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
