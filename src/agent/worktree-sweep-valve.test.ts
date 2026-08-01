/**
 * Tests for the per-root soft-launch valve (review item 3, PR #771).
 *
 * Covers the errno-discrimination in `readRootSweepCount`: a directory-missing
 * root falls back to the legacy machine-global count (`null`), while an
 * unwritable/unusable marker inside an EXISTING `.afk-worktrees/` forces a
 * preview (`0`) rather than silently inheriting an exhausted global count.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRootSweepCount } from './worktree-sweep-valve.js';

let repoRoot: string;

async function withTempRepo(fn: (root: string) => Promise<void>): Promise<void> {
  repoRoot = mkdtempSync(join(tmpdir(), 'afk-valve-test-'));
  try {
    await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe('readRootSweepCount', () => {
  it('returns null when .afk-worktrees/ does not exist (legacy fallback preserved)', async () => {
    await withTempRepo(async (root) => {
      // No .afk-worktrees/ directory created at all.
      const result = await readRootSweepCount(root);
      expect(result).toBeNull();
    });
  });

  it('forces a preview (returns 0) when .afk-worktrees/ exists but the marker is a directory, not a file', async () => {
    await withTempRepo(async (root) => {
      // A directory at the marker's path makes both the read AND the write
      // fail — the write fails EISDIR, not ENOENT, because .afk-worktrees/
      // itself is present. This is the cross-platform substitute for a
      // chmod-based permissions test (flaky, and skipped on Windows CI).
      const afkWorktreesDir = join(root, '.afk-worktrees');
      await fs.mkdir(join(afkWorktreesDir, '.sweep-runs'), { recursive: true });

      const result = await readRootSweepCount(root);
      expect(result).toBe(0);
    });
  });

  it('reads back a valid existing count normally', async () => {
    await withTempRepo(async (root) => {
      const afkWorktreesDir = join(root, '.afk-worktrees');
      await fs.mkdir(afkWorktreesDir, { recursive: true });
      await fs.writeFile(join(afkWorktreesDir, '.sweep-runs'), '2', 'utf-8');

      const result = await readRootSweepCount(root);
      expect(result).toBe(2);
    });
  });

  it('initializes a fresh marker to 0 when .afk-worktrees/ exists and no marker is present yet', async () => {
    await withTempRepo(async (root) => {
      const afkWorktreesDir = join(root, '.afk-worktrees');
      await fs.mkdir(afkWorktreesDir, { recursive: true });

      const result = await readRootSweepCount(root);
      expect(result).toBe(0);
      expect((await fs.readFile(join(afkWorktreesDir, '.sweep-runs'), 'utf-8')).trim()).toBe('0');
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end through runSweep: an unusable marker forces dry-run even when
// the machine-global telemetry count is exhausted, while a directory-missing
// root still takes the legacy fallback.
// ---------------------------------------------------------------------------

import { runSweep } from './worktree-sweep.js';
import type { ExecFileFn } from './worktree-sweep.js';

function writeFakeExhaustedTelemetry(path: string): void {
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    lines.push(
      JSON.stringify({
        taskId: 'worktree-prune',
        status: 'success',
        triggeredAt: new Date().toISOString(),
      }),
    );
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

describe('runSweep + valve integration (review item 3)', () => {
  it('forces a dry-run when the marker is unusable, even with an exhausted machine-global count', async () => {
    await withTempRepo(async (root) => {
      const afkWorktreesDir = join(root, '.afk-worktrees');
      // Marker path occupied by a directory → write fails EISDIR, not ENOENT.
      await fs.mkdir(join(afkWorktreesDir, '.sweep-runs'), { recursive: true });

      const telemetryPath = join(root, 'telemetry.jsonl');
      writeFakeExhaustedTelemetry(telemetryPath);

      const mock = (async (_file: string, args: string[]) => {
        if (args.includes('list') && args.includes('--porcelain')) {
          return { stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }) as ExecFileFn;

      const result = await runSweep({
        execFile: mock,
        repoRoot: root,
        lockPath: join(root, 'sweep.lock'),
        dryRun: false,
        telemetryPath,
      });

      // Even though the global telemetry count is 10 (>> SOFT_LAUNCH_RUNS),
      // the unusable marker must force a preview rather than inherit it.
      expect(result.dryRun).toBe(true);
    });
  });

  it('still takes the legacy machine-global fallback when .afk-worktrees/ does not exist', async () => {
    await withTempRepo(async (root) => {
      // No .afk-worktrees/ at all — nothing for the sweep to do, and no
      // marker is possible. This root has no worktrees, so the porcelain
      // list need only report the main worktree.
      const telemetryPath = join(root, 'telemetry.jsonl');
      writeFakeExhaustedTelemetry(telemetryPath); // exhausted → legacy fallback opens the valve

      const mock = (async (_file: string, args: string[]) => {
        if (args.includes('list') && args.includes('--porcelain')) {
          return { stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }) as ExecFileFn;

      const result = await runSweep({
        execFile: mock,
        repoRoot: root,
        lockPath: join(root, 'sweep.lock'),
        dryRun: false,
        telemetryPath,
      });

      expect(result.dryRun).toBe(false);
    });
  });
});
