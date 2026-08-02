/**
 * Tests for the daemon's builtin worktree-prune tick across MULTIPLE roots (#771).
 *
 * PR #761 made the tick fan out over `sweepRootSet()` instead of a single
 * resolved root. That fan-out shipped uncovered, so the per-root failure
 * isolation, the aggregation, and the skip branch all live here.
 *
 * Kept out of `scheduler.test.ts` deliberately: this file mocks
 * `../worktree-sweep.js` and `../worktree-root-registry.js` module-wide, and
 * `vi.mock` is file-scoped — folding these in would silently re-point those
 * modules for the 30 unrelated telemetry tests next door.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('resolveProvider is not used by these tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({ registry: undefined, memoryStore: { close: () => {} } }),
}));

// Mirrors scheduler.test.ts: register() otherwise arms a real wall-clock timer
// whose background tick can outlive stop() and pollute a sibling test.
vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

vi.mock('../worktree-sweep.js', () => ({ runSweep: vi.fn() }));
vi.mock('../worktree-root-registry.js', () => ({ sweepRootSet: vi.fn() }));

import { CronScheduler } from './scheduler.js';
import { runSweep } from '../worktree-sweep.js';
import { sweepRootSet } from '../worktree-root-registry.js';
import type { SweepResult } from '../worktree-sweep.js';

const mockRunSweep = vi.mocked(runSweep);
const mockSweepRootSet = vi.mocked(sweepRootSet);

const PRUNE_COMMAND = '__BUILTIN_WORKTREE_PRUNE__';

function sweepResult(over: Partial<SweepResult> = {}): SweepResult {
  return { removed: [], warnings: [], dryRun: false, candidates: [], ...over };
}

let tmp: string;
let telemetryPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-prune-'));
  telemetryPath = join(tmp, 'telemetry.jsonl');
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function tickPrune(): Promise<{ status: string; excerpt: string; errorMessage: string }> {
  const scheduler = new CronScheduler({ telemetryPath });
  scheduler.register({
    taskId: 'worktree-prune',
    command: PRUNE_COMMAND,
    trigger: 'cron',
    cronExpression: '0 * * * *',
  });
  const record = await scheduler.tick('worktree-prune');
  await scheduler.stop();
  return {
    status: record.status,
    excerpt: record.responseExcerpt ?? '',
    errorMessage: record.errorMessage ?? '',
  };
}

describe('builtin worktree-prune across multiple roots', () => {
  it('sweeps every root in the set, once each', async () => {
    mockSweepRootSet.mockResolvedValue(['/repo/a', '/repo/b']);
    mockRunSweep.mockResolvedValue(sweepResult());

    const { status } = await tickPrune();

    expect(status).toBe('success');
    expect(mockRunSweep).toHaveBeenCalledTimes(2);
    expect(mockRunSweep.mock.calls.map((c) => c[0]?.repoRoot)).toEqual(['/repo/a', '/repo/b']);
  });

  it('F-T2: a MIXED live/preview tick still reports the real removal count', async () => {
    // Reachable since the soft-launch valve became per-root: an established
    // root sweeps live while a freshly registered one is held in preview. The
    // old summary folded dryRun with some() and printed only the preview
    // sentence, so the live root's removals never appeared in the record — and
    // that record is what cli/commands/daemon.ts pushes to the operator.
    mockSweepRootSet.mockResolvedValue(['/repo/established', '/repo/fresh']);
    mockRunSweep
      .mockResolvedValueOnce(sweepResult({ removed: ['gone-1', 'gone-2'], dryRun: false }))
      .mockResolvedValueOnce(sweepResult({
        dryRun: true,
        candidates: [
          { path: '/repo/fresh/.afk-worktrees/x', verdict: 'empty', owner: 'interactive', ageMs: 0 },
        ],
      }));

    const { status, excerpt } = await tickPrune();

    expect(status).toBe('success');
    expect(excerpt).toContain('removed 2');
    expect(excerpt).toContain('would remove 1 on 1 preview root(s)');
  });

  it('F-O2: a contested root is not counted as swept', async () => {
    mockSweepRootSet.mockResolvedValue(['/repo/a', '/repo/b']);
    mockRunSweep
      .mockResolvedValueOnce(sweepResult({ removed: ['gone'] }))
      .mockResolvedValueOnce(sweepResult({ contested: true, warnings: ['[WARN] lock held'] }));

    const { excerpt } = await tickPrune();

    expect(excerpt).toContain('across 1/2 root(s)');
    expect(excerpt).toContain('1 contested');
  });

  it('concatenates removals and warnings across roots', async () => {
    mockSweepRootSet.mockResolvedValue(['/repo/a', '/repo/b']);
    mockRunSweep
      .mockResolvedValueOnce(sweepResult({ removed: ['a1', 'a2'], warnings: ['aw'] }))
      .mockResolvedValueOnce(sweepResult({ removed: ['b1'], warnings: ['bw1', 'bw2'] }));

    const { status, excerpt } = await tickPrune();

    expect(status).toBe('success');
    // 3 removed = 2 + 1, 3 warned = 1 + 2 — proof the flatMap merges rather
    // than overwriting, and that both roots are attributed in the summary.
    expect(excerpt).toContain('removed 3, warned 3');
    expect(excerpt).toContain('2/2 root(s)');
  });

  it('keeps sweeping after a root fails, and reports the failure as a warning', async () => {
    // Regression for the starvation bug: runSweep rejects when its opening
    // `git worktree list` exits nonzero (a registered dir whose .git was
    // deleted). Uncaught, that aborted the loop and stranded every root behind
    // it on EVERY tick — the #761 leak, reintroduced.
    mockSweepRootSet.mockResolvedValue(['/repo/broken', '/repo/healthy']);
    mockRunSweep
      .mockRejectedValueOnce(new Error('fatal: not a git repository'))
      .mockResolvedValueOnce(sweepResult({ removed: ['h1'] }));

    const { status, excerpt } = await tickPrune();

    expect(mockRunSweep).toHaveBeenCalledTimes(2);
    expect(mockRunSweep.mock.calls[1]?.[0]?.repoRoot).toBe('/repo/healthy');
    // The tick still succeeds and still reports the healthy root's removal.
    expect(status).toBe('success');
    expect(excerpt).toContain('removed 1');
    expect(excerpt).toContain('1/2 root(s)');

    const warnings = readFileSync(telemetryPath, 'utf-8');
    expect(warnings).toContain('worktree-prune');
  });

  it('surfaces a per-root failure in the aggregated warning count', async () => {
    mockSweepRootSet.mockResolvedValue(['/repo/broken', '/repo/healthy']);
    mockRunSweep
      .mockRejectedValueOnce(new Error('fatal: not a git repository'))
      .mockResolvedValueOnce(sweepResult());

    const { excerpt, errorMessage } = await tickPrune();

    // One warning, and it is the synthesized [ERROR] line for the bad root.
    expect(excerpt).toContain('warned 1');
    // A PARTIAL failure stays `success` and carries no errorMessage — only a
    // tick where every root failed is a systemic one. Without this, an
    // over-broad gate on the error branch would go unnoticed. (`tickPrune`
    // normalizes an absent field to '', so that is the assertion here.)
    expect(errorMessage).toBe('');
  });

  it('still errors the tick if every root fails', async () => {
    mockSweepRootSet.mockResolvedValue(['/repo/a', '/repo/b']);
    mockRunSweep.mockRejectedValue(new Error('boom'));

    const { status, excerpt, errorMessage } = await tickPrune();

    // An error record — every root rejected, so the tick reclaimed nothing
    // and must not report as healthy (src/insights/aggregators/daemon.ts only
    // tallies errorCount/recentErrors off status === 'error').
    expect(status).toBe('error');
    expect(errorMessage).toContain('2 root(s) failed sweep');
    // Basenames only. errorMessage is PERSISTED to a telemetry file written
    // with a bare appendFileSync (umask ⇒ world-readable) and is forwarded
    // into a Telegram push body, so it must never enumerate the absolute path
    // of every repo the operator works in — the registry file is 0o600 for
    // exactly that reason. Full paths stay in the unpersisted warnings.
    expect(errorMessage).toContain('a: ');
    expect(errorMessage).toContain('b: ');
    expect(errorMessage).not.toContain('/repo/a');
    expect(errorMessage).not.toContain('/repo/b');
    // The excerpt (candidate/removal summary) is unchanged by this fix — both
    // failures are still visible as warnings against 0 swept roots.
    expect(excerpt).toContain('warned 2');
    expect(excerpt).toContain('0/2 root(s)');
  });

  it('skips with a message naming both causes when no root is known', async () => {
    mockSweepRootSet.mockResolvedValue([]);

    const { status, excerpt } = await tickPrune();

    expect(status).toBe('skipped');
    expect(mockRunSweep).not.toHaveBeenCalled();
    expect(excerpt).toContain('not inside a git repository');
    expect(excerpt).toContain('no managed worktree roots are registered');
  });
});
