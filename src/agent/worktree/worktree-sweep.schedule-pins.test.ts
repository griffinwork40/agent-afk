/**
 * Unit tests for the schedule-pins guard (resolveSchedulePins).
 *
 * Tests cover:
 *   - pinned by an enabled schedule
 *   - pinned by a disabled schedule (disabled must still protect)
 *   - unrelated schedule cwd (no pin)
 *   - malformed schedules file
 *   - missing schedules file
 *
 * Also has integration tests via runSweep that verify the sweep engine
 * respects schedule pins end-to-end.
 *
 * @module agent/worktree/worktree-sweep.schedule-pins.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  promises as fs,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSchedulePins } from './worktree-sweep.schedule-pins.js';
import { runSweep } from './worktree-sweep.js';
import type { ExecFileFn } from './worktree-sweep.js';
import type { ScheduledTaskConfig } from '../daemon/schedule-store.js';

// ---------------------------------------------------------------------------
// Helpers shared with the main sweep test
// ---------------------------------------------------------------------------

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

async function writeRootMarker(root: string, count: number): Promise<void> {
  await fs.writeFile(join(root, '.afk-worktrees', '.sweep-runs'), String(count), 'utf-8');
}

function writeFakeTelemetry(path: string, count: number): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({ taskId: 'worktree-prune', status: 'success', triggeredAt: new Date().toISOString() }));
  }
  writeFileSync(path, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

function writeSchedules(schedulesPath: string, tasks: Partial<ScheduledTaskConfig>[]): void {
  const full = tasks.map((t, i) => ({
    id: `task-${i}`,
    name: `Task ${i}`,
    command: `/task ${i}`,
    cron: '0 0 * * *',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...t,
  } as ScheduledTaskConfig));
  writeFileSync(schedulesPath, JSON.stringify(full, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmpDir: string;
let schedulesPath: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'afk-pins-test-')));
  schedulesPath = join(tmpDir, 'schedules.json');
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Unit tests for resolveSchedulePins
// ---------------------------------------------------------------------------

describe('resolveSchedulePins', () => {
  it('returns empty pin set when worktreePaths is empty', async () => {
    writeSchedules(schedulesPath, [{ cwd: '/some/path' }]);
    const result = await resolveSchedulePins([], schedulesPath);
    expect(result.pinnedByTask.size).toBe(0);
    expect(result.notes).toHaveLength(0);
  });

  it('pins a worktree when an ENABLED schedule cwd is inside it', async () => {
    const worktreePath = join(tmpDir, '.afk-worktrees', 'my-wt');
    const taskCwd = join(worktreePath, 'subdir');
    writeSchedules(schedulesPath, [{ id: 'enabled-task', cwd: taskCwd, enabled: true }]);

    const result = await resolveSchedulePins([worktreePath], schedulesPath);
    expect(result.pinnedByTask.get(worktreePath)).toBe('enabled-task');
    expect(result.notes).toHaveLength(0);
  });

  it('pins a worktree when a DISABLED schedule cwd is inside it', async () => {
    const worktreePath = join(tmpDir, '.afk-worktrees', 'my-wt');
    const taskCwd = join(worktreePath, 'deep', 'nested');
    writeSchedules(schedulesPath, [{ id: 'disabled-task', cwd: taskCwd, enabled: false }]);

    const result = await resolveSchedulePins([worktreePath], schedulesPath);
    expect(result.pinnedByTask.get(worktreePath)).toBe('disabled-task');
    expect(result.notes).toHaveLength(0);
  });

  it('pins a worktree when a schedule cwd IS the worktree path exactly', async () => {
    const worktreePath = join(tmpDir, '.afk-worktrees', 'exact-wt');
    writeSchedules(schedulesPath, [{ id: 'exact-task', cwd: worktreePath, enabled: true }]);

    const result = await resolveSchedulePins([worktreePath], schedulesPath);
    expect(result.pinnedByTask.get(worktreePath)).toBe('exact-task');
  });

  it('does NOT pin a worktree when the schedule cwd is unrelated', async () => {
    const worktreePath = join(tmpDir, '.afk-worktrees', 'my-wt');
    const unrelatedCwd = join(tmpDir, 'other-project');
    writeSchedules(schedulesPath, [{ id: 'unrelated-task', cwd: unrelatedCwd, enabled: true }]);

    const result = await resolveSchedulePins([worktreePath], schedulesPath);
    expect(result.pinnedByTask.has(worktreePath)).toBe(false);
    expect(result.notes).toHaveLength(0);
  });

  it('does NOT pin a worktree when schedule has no cwd', async () => {
    const worktreePath = join(tmpDir, '.afk-worktrees', 'my-wt');
    writeSchedules(schedulesPath, [{ id: 'no-cwd-task', enabled: true }]);

    const result = await resolveSchedulePins([worktreePath], schedulesPath);
    expect(result.pinnedByTask.has(worktreePath)).toBe(false);
  });

  it('returns a note (not a throw) when the schedules file contains invalid JSON', async () => {
    writeFileSync(schedulesPath, 'NOT VALID JSON', 'utf-8');

    const result = await resolveSchedulePins([join(tmpDir, 'some-wt')], schedulesPath);
    expect(result.pinnedByTask.size).toBe(0);
    expect(result.notes.some((n) => n.includes('[WARN]') && n.includes('invalid JSON'))).toBe(true);
  });

  it('returns an info note (not a throw) when the schedules file is missing', async () => {
    const missingPath = join(tmpDir, 'nonexistent-schedules.json');

    const result = await resolveSchedulePins([join(tmpDir, 'some-wt')], missingPath);
    expect(result.pinnedByTask.size).toBe(0);
    expect(result.notes.some((n) => n.includes('[INFO]') && n.includes('not found'))).toBe(true);
  });

  it('records only the first pinning task when multiple tasks overlap the same worktree', async () => {
    const worktreePath = join(tmpDir, '.afk-worktrees', 'shared-wt');
    writeSchedules(schedulesPath, [
      { id: 'first-task', cwd: worktreePath, enabled: true },
      { id: 'second-task', cwd: join(worktreePath, 'sub'), enabled: false },
    ]);

    const result = await resolveSchedulePins([worktreePath], schedulesPath);
    // First match wins; second is still covered because the worktree is already pinned.
    expect(result.pinnedByTask.get(worktreePath)).toBe('first-task');
  });
});

// ---------------------------------------------------------------------------
// Integration tests via runSweep
// ---------------------------------------------------------------------------

describe('runSweep — schedule-pins integration', () => {
  let repoRoot: string;
  let afkWorktreesDir: string;
  let telemetryFile: string;
  let lockFile: string;

  beforeEach(async () => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-sweep-pin-int-')));
    afkWorktreesDir = join(repoRoot, '.afk-worktrees');
    await fs.mkdir(afkWorktreesDir, { recursive: true });
    telemetryFile = join(repoRoot, 'fake-telemetry.jsonl');
    lockFile = join(repoRoot, 'sweep.lock');
    writeFakeTelemetry(telemetryFile, 3);
    await writeRootMarker(repoRoot, 3);
  });

  afterEach(() => {
    try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Helper: build an execFile mock for a single worktree that would normally be
  // classified as 'empty' and therefore removed.
  function makeEmptyWorktreeMock(mainPath: string, worktreePath: string): ExecFileFn {
    return makeMock(async ({ file, args }) => {
      if (file === 'git' && args.includes('list') && args.includes('--porcelain')) {
        return {
          stdout: [
            worktreeBlock({ path: mainPath, isBare: false, branch: 'refs/heads/main' }),
            '',
            worktreeBlock({ path: worktreePath, branch: 'refs/heads/afk/test-wt' }),
          ].join('\n\n'),
          stderr: '',
        };
      }
      if (file === 'git' && args.includes('status')) return { stdout: '', stderr: '' };
      if (file === 'git' && args.includes('ls-files')) return { stdout: '', stderr: '' };
      if (file === 'git' && args.includes('rev-list')) return { stdout: '0', stderr: '' };
      if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
        return { stdout: '', stderr: '' };
      }
      if (file === 'git' && args.includes('branch') && args.includes('-d')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
  }

  it('preserves a normally-empty worktree pinned by an ENABLED schedule (not reaped)', async () => {
    const worktreePath = join(afkWorktreesDir, 'enabled-pinned-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    const taskCwd = join(worktreePath, 'workspace');
    writeSchedules(schedulesPath, [{ id: 'nightly-run', cwd: taskCwd, enabled: true }]);

    // Write old meta so it would normally classify as 'dead-owner'/'empty'.
    const meta = { owner: 'interactive', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), pid: 99999 };
    writeFileSync(join(worktreePath, '.afk-worktree-meta.json'), JSON.stringify(meta), 'utf-8');

    const execFile = makeEmptyWorktreeMock(repoRoot, worktreePath);

    const result = await runSweep({
      execFile,
      repoRoot,
      dryRun: false,
      telemetryPath: telemetryFile,
      lockPath: lockFile,
      bypassSoftLaunch: true,
      readPresence: async () => [],
      schedulesPath,
    });

    expect(result.removed).not.toContain(worktreePath);
    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).toBe('active');
    // A warning naming the task id and 'schedule-pinned' must appear.
    expect(result.warnings.some((w) => w.includes('nightly-run') && w.includes('schedule-pinned'))).toBe(true);
  });

  it('preserves a normally-empty worktree pinned by a DISABLED schedule (not reaped)', async () => {
    const worktreePath = join(afkWorktreesDir, 'disabled-pinned-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    const taskCwd = worktreePath; // cwd IS the worktree
    writeSchedules(schedulesPath, [{ id: 'outcome-relabel', cwd: taskCwd, enabled: false }]);

    const meta = { owner: 'interactive', createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), pid: 99999 };
    writeFileSync(join(worktreePath, '.afk-worktree-meta.json'), JSON.stringify(meta), 'utf-8');

    const execFile = makeEmptyWorktreeMock(repoRoot, worktreePath);

    const result = await runSweep({
      execFile,
      repoRoot,
      dryRun: false,
      telemetryPath: telemetryFile,
      lockPath: lockFile,
      bypassSoftLaunch: true,
      readPresence: async () => [],
      schedulesPath,
    });

    expect(result.removed).not.toContain(worktreePath);
    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).toBe('active');
    expect(result.warnings.some((w) => w.includes('outcome-relabel') && w.includes('schedule-pinned'))).toBe(true);
  });

  it('reaps a worktree when the only schedule cwd is UNRELATED', async () => {
    const worktreePath = join(afkWorktreesDir, 'unrelated-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    const unrelatedCwd = join(repoRoot, 'other-project', 'tasks');
    writeSchedules(schedulesPath, [{ id: 'unrelated-task', cwd: unrelatedCwd, enabled: true }]);

    const meta = { owner: 'interactive', createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), pid: 99999 };
    writeFileSync(join(worktreePath, '.afk-worktree-meta.json'), JSON.stringify(meta), 'utf-8');

    const execFile = makeEmptyWorktreeMock(repoRoot, worktreePath);

    const result = await runSweep({
      execFile,
      repoRoot,
      dryRun: false,
      telemetryPath: telemetryFile,
      lockPath: lockFile,
      bypassSoftLaunch: true,
      readPresence: async () => [],
      schedulesPath,
    });

    // Not pinned — should be removed (either 'dead-owner' or 'empty').
    expect(result.removed).toContain(worktreePath);
    const candidate = result.candidates.find((c) => c.path === worktreePath);
    expect(candidate?.verdict).not.toBe('active');
  });

  it('falls back gracefully (no throw, no pin) when schedules file is malformed', async () => {
    const worktreePath = join(afkWorktreesDir, 'malformed-test-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    writeFileSync(schedulesPath, '{broken json', 'utf-8');

    const meta = { owner: 'interactive', createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), pid: 99999 };
    writeFileSync(join(worktreePath, '.afk-worktree-meta.json'), JSON.stringify(meta), 'utf-8');

    const execFile = makeEmptyWorktreeMock(repoRoot, worktreePath);

    const result = await runSweep({
      execFile,
      repoRoot,
      dryRun: false,
      telemetryPath: telemetryFile,
      lockPath: lockFile,
      bypassSoftLaunch: true,
      readPresence: async () => [],
      schedulesPath,
    });

    // Malformed file means no pin — normal sweep proceeds and notes the issue.
    expect(result.warnings.some((w) => w.includes('[WARN]') && w.includes('invalid JSON'))).toBe(true);
    // No crash: removed list is either populated or empty, but result exists.
    expect(Array.isArray(result.removed)).toBe(true);
  });

  it('falls back gracefully (no throw, no pin) when schedules file is missing', async () => {
    const worktreePath = join(afkWorktreesDir, 'missing-sched-wt');
    await fs.mkdir(worktreePath, { recursive: true });

    const missingSchedulesPath = join(repoRoot, 'no-such-schedules.json');

    const meta = { owner: 'interactive', createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), pid: 99999 };
    writeFileSync(join(worktreePath, '.afk-worktree-meta.json'), JSON.stringify(meta), 'utf-8');

    const execFile = makeEmptyWorktreeMock(repoRoot, worktreePath);

    const result = await runSweep({
      execFile,
      repoRoot,
      dryRun: false,
      telemetryPath: telemetryFile,
      lockPath: lockFile,
      bypassSoftLaunch: true,
      readPresence: async () => [],
      schedulesPath: missingSchedulesPath,
    });

    // Missing file: an info note appears.
    expect(result.warnings.some((w) => w.includes('[INFO]') && w.includes('not found'))).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
  });
});
