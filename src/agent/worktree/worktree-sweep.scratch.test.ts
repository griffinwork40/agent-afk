/**
 * Item 4 (sweep action path): tests that the background sweep engine correctly
 * handles worktrees whose only content is `.afk-scratch/` files, exercising the
 * `probeCandidate` → `probeNonRebuildableIgnoredFiles` path inside `runSweep`.
 *
 * The existing sweep tests (worktree-sweep.test.ts) cover `.env` as a
 * non-rebuildable ignored file but do not pin the `.afk-scratch/` case or the
 * scratchDisposable opt-in that lets it be disposed.  These tests fill that gap.
 *
 * Strategy: same mocked-ExecFileFn pattern as worktree-sweep.test.ts with a
 * per-test lock path and seeded soft-launch counter so the valve opens. All
 * injectable sweep options (telemetryPath, lockPath, readPresence) are
 * explicitly provided so the test never reads AFK_HOME or the real filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from './worktree-sweep.js';
import type { ExecFileFn } from './worktree-sweep.js';

type ExecResult = { stdout: string; stderr: string };
type ExecCall = { file: string; args: string[]; opts?: { cwd?: string } };

interface MockExecFile {
  (file: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  calls: ExecCall[];
}

function makeMock(handler: (call: ExecCall) => Promise<ExecResult>): MockExecFile {
  const calls: ExecCall[] = [];
  const fn = ((file: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, opts });
    return handler({ file, args, opts });
  }) as MockExecFile;
  fn.calls = calls;
  return fn;
}

function worktreeBlock(opts: {
  path: string;
  head?: string;
  branch?: string;
}): string {
  return [
    `worktree ${opts.path}`,
    `HEAD ${opts.head ?? 'abc1234abc1234abc1234abc1234abc1234abc1234'}`,
    `branch ${opts.branch ?? 'refs/heads/afk/test-branch'}`,
  ].join('\n');
}

/** Seed the per-root soft-launch marker so the valve opens for this root. */
async function writeRootMarker(root: string, count: number): Promise<void> {
  await fs.writeFile(join(root, '.afk-worktrees', '.sweep-runs'), String(count), 'utf-8');
}

/** Write a minimal telemetry file as the fallback for roots without a marker. */
function writeFakeTelemetry(path: string, count: number): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        taskId: 'worktree-prune',
        status: 'success',
        triggeredAt: new Date().toISOString(),
      }),
    );
  }
  writeFileSync(path, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

let repoRoot: string;
let afkWorktreesDir: string;
let telemetryFile: string;
let lockFile: string;

beforeEach(async () => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-sweep-scratch-')));
  afkWorktreesDir = join(repoRoot, '.afk-worktrees');
  await fs.mkdir(afkWorktreesDir, { recursive: true });
  telemetryFile = join(repoRoot, 'fake-telemetry.jsonl');
  lockFile = join(repoRoot, 'sweep.lock');
  writeFakeTelemetry(telemetryFile, 3);
  await writeRootMarker(repoRoot, 3);
});

afterEach(() => {
  try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

/** Common sweep options that bypass all global state reads. */
function sweepOpts(execFile: ExecFileFn, dryRun = false) {
  return {
    execFile,
    repoRoot,
    lockPath: lockFile,
    dryRun,
    telemetryPath: telemetryFile,
    readPresence: async () => [],
  } as const;
}

// ---------------------------------------------------------------------------
// Item 4 — sweep action path: .afk-scratch/ in a worktree
// ---------------------------------------------------------------------------

describe('sweep — .afk-scratch/ probe path (item 4)', () => {
  // A tree whose status reads clean but whose only ignored content is
  // .afk-scratch/ WITHOUT the scratchDisposable opt-in must NOT be reaped.
  // The probe sees `!! .afk-scratch/file` as a non-rebuildable ignored entry
  // (no meta says it is disposable) → preserve.
  it('preserves a scratch-only tree when scratchDisposable opt-in is absent', async () => {
    const wtPath = join(afkWorktreesDir, 'afk-scratch-no-optin');
    await fs.mkdir(wtPath, { recursive: true });
    // Meta present but scratchDisposable omitted — this is what "no opt-in"
    // means.  createdAt is 20 days in the past so the tree clears the
    // MIN_EMPTY_AGE_MS gate and classifyCandidate returns 'empty', causing
    // probeCandidate to actually invoke probeNonRebuildableIgnoredFiles.
    // Without this age, the tree gets verdict 'active' and the probe is never
    // reached, making both assertions vacuously pass regardless of whether
    // .afk-scratch/ is treated as non-rebuildable.
    await fs.writeFile(
      join(wtPath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );
    const porcelainOut =
      `${worktreeBlock({ path: repoRoot, head: 'base123' })}\n\n` +
      `${worktreeBlock({ path: wtPath, head: 'base123', branch: 'refs/heads/afk/scratch-no-optin' })}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) return { stdout: porcelainOut, stderr: '' };
      if (args.includes('status') && args.includes('--ignored')) return { stdout: '!! .afk-scratch/\n!! .afk-scratch/notes.md\n', stderr: '' };
      if (args.includes('status') && args.includes('--porcelain')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list') && args.includes('--count')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep(sweepOpts(mock as ExecFileFn));

    // Must not be removed.
    expect(result.removed).not.toContain(wtPath);
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  // A tree whose status reads clean but whose only ignored content is
  // .afk-scratch/ WITH scratchDisposable: true in meta IS disposable.
  // The probe reads the meta, skips .afk-scratch/ lines, and returns
  // protect: false → the sweep removes it.
  it('reaps a scratch-only tree when scratchDisposable opt-in is present', async () => {
    const wtPath = join(afkWorktreesDir, 'afk-scratch-opted-in');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(
      join(wtPath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        scratchDisposable: true,
        createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const porcelainOut =
      `${worktreeBlock({ path: repoRoot, head: 'base123' })}\n\n` +
      `${worktreeBlock({ path: wtPath, head: 'base123', branch: 'refs/heads/afk/scratch-opted-in' })}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) return { stdout: porcelainOut, stderr: '' };
      if (args.includes('status') && args.includes('--ignored')) return { stdout: '!! .afk-scratch/\n!! .afk-scratch/pr-body.md\n', stderr: '' };
      if (args.includes('status') && args.includes('--porcelain')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list') && args.includes('--count')) return { stdout: '0\n', stderr: '' };
      if (args.includes('worktree') && args.includes('remove')) return { stdout: '', stderr: '' };
      if (args.includes('branch') && args.includes('-d')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep(sweepOpts(mock as ExecFileFn));

    expect(result.removed).toContain(wtPath);
  });

  // When scratchDisposable is present but false (or the wrong type), the
  // probe must still refuse — the flag is only trusted when exactly true.
  it('preserves a scratch-only tree when scratchDisposable is present but false', async () => {
    const wtPath = join(afkWorktreesDir, 'afk-scratch-false-optin');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(
      join(wtPath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        scratchDisposable: false,
        createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const porcelainOut =
      `${worktreeBlock({ path: repoRoot, head: 'base123' })}\n\n` +
      `${worktreeBlock({ path: wtPath, head: 'base123', branch: 'refs/heads/afk/scratch-false-optin' })}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) return { stdout: porcelainOut, stderr: '' };
      if (args.includes('status') && args.includes('--ignored')) return { stdout: '!! .afk-scratch/\n!! .afk-scratch/secret.md\n', stderr: '' };
      if (args.includes('status') && args.includes('--porcelain')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list') && args.includes('--count')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep(sweepOpts(mock as ExecFileFn));

    expect(result.removed).not.toContain(wtPath);
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  // A scratch-only opted-in tree in dry-run must NOT be removed.
  it('dry-run does not remove an opted-in scratch tree', async () => {
    const wtPath = join(afkWorktreesDir, 'afk-scratch-dryrun');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(
      join(wtPath, '.afk-worktree-meta.json'),
      JSON.stringify({
        owner: 'agent',
        scratchDisposable: true,
        createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(),
        baseSha: 'base123',
        baseBranch: 'main',
      }),
    );

    const porcelainOut =
      `${worktreeBlock({ path: repoRoot, head: 'base123' })}\n\n` +
      `${worktreeBlock({ path: wtPath, head: 'base123', branch: 'refs/heads/afk/scratch-dryrun' })}\n`;

    const mock = makeMock(async ({ args }) => {
      if (args.includes('list') && args.includes('--porcelain')) return { stdout: porcelainOut, stderr: '' };
      if (args.includes('status') && args.includes('--ignored')) return { stdout: '!! .afk-scratch/\n!! .afk-scratch/plan.md\n', stderr: '' };
      if (args.includes('status') && args.includes('--porcelain')) return { stdout: '', stderr: '' };
      if (args.includes('rev-list') && args.includes('--count')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runSweep(sweepOpts(mock as ExecFileFn, true));

    expect(result.dryRun).toBe(true);
    expect(result.removed).not.toContain(wtPath);
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });
});
