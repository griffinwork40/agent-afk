/**
 * Tests for the `afk farm` command.
 *
 * Mocks `createFarm` and `runSubagentDAG` so no real git or agent calls occur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FarmManifest, CreatedBranch } from '../../agent/worktree.js';
import type { DAGRunResult } from '../../agent/dag.js';
import { runFarm, FarmIsolationViolation } from './farm.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBranch(index: number, label?: string): CreatedBranch {
  return {
    index,
    label,
    path: `/tmp/farm/branch-${index}`,
    branch: `afk/farm/test-slug/${index}-${label ?? `branch-${index}`}`,
  };
}

function makeManifest(count: number, labels?: string[]): FarmManifest {
  const branches = Array.from({ length: count }, (_, i) =>
    makeBranch(i + 1, labels?.[i]),
  );
  return {
    schemaVersion: 1,
    taskId: 'test-slug',
    taskSlug: 'test-slug',
    taskName: 'test task',
    repoRoot: '/tmp/repo',
    baseRef: 'abc123',
    farmDir: '/tmp/farm',
    createdAt: new Date().toISOString(),
    branches,
  };
}

function makeDAGResult(
  count: number,
  failedIndices: number[] = [],
  skippedIndices: number[] = [],
): DAGRunResult {
  return {
    outputs: {},
    failed: failedIndices.map((i) => ({
      id: `branch-${i}`,
      error: new Error(`branch-${i} failed`),
    })),
    skipped: skippedIndices.map((i) => `branch-${i}`),
  };
}

// ---------------------------------------------------------------------------
// process.exit mock
// ---------------------------------------------------------------------------

let exitCode: number | undefined;
let originalExit: typeof process.exit;

beforeEach(() => {
  exitCode = undefined;
  originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.exit = originalExit;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper to run runFarm and catch the exit throw
// ---------------------------------------------------------------------------

async function runFarmCatch(opts: Parameters<typeof runFarm>[0]): Promise<void> {
  try {
    // Defaults disable every side-effecting tail-call so tests don't hit the
    // real scorer, real MemoryStore (SQLite on disk), or real Telegram push.
    // Individual tests opt back in by passing the relevant flag PLUS injection
    // mocks (`_scoreBranch`, `_writeFarmFact`, `_sendFarmDigest`, etc.).
    const defaulted: Parameters<typeof runFarm>[0] = {
      score: false,
      memoryWrite: false,
      digest: false,
      ...opts,
    };
    await runFarm(defaulted);
  } catch (err) {
    // process.exit throws in tests — swallow it
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith('process.exit(')) throw err;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFarm', () => {
  describe('happy path — 3 branches all succeed', () => {
    it('calls createFarm with the correct arguments', async () => {
      const manifest = makeManifest(3);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(3));
      const getCommitCountMock = vi.fn().mockResolvedValue(2);
      const getDirtyMock = vi.fn().mockResolvedValue([]);

      await runFarmCatch({
        task: 'my task',
        branches: 3,
        cwd: '/tmp/repo',
        failFast: false,
        taskSlug: 'test-slug',
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
      });

      expect(createFarmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          taskName: 'my task',
          count: 3,
          cwd: '/tmp/repo',
          taskSlug: 'test-slug',
        }),
      );
    });

    it('dispatches via runSubagentDAG with 3 nodes and no edges', async () => {
      const manifest = makeManifest(3);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(3));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);

      await runFarmCatch({
        task: 'test',
        branches: 3,
        failFast: false,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
      });

      expect(runDAGMock).toHaveBeenCalledOnce();
      const dagArgs = runDAGMock.mock.calls[0]![0];
      expect(dagArgs.nodes).toHaveLength(3);
      expect(dagArgs.edges).toEqual([]);
      expect(dagArgs.failFast).toBe(false);
    });

    it('exits 0 when all branches succeed and source repo is clean', async () => {
      const manifest = makeManifest(3);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(3));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);

      await runFarmCatch({
        task: 'test',
        branches: 3,
        failFast: false,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
      });

      expect(exitCode).toBe(0);
    });

    it('sets cwd on each DAG node matching the branch path', async () => {
      const manifest = makeManifest(3);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(3));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);

      await runFarmCatch({
        task: 'test',
        branches: 3,
        failFast: false,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
      });

      const dagArgs = runDAGMock.mock.calls[0]![0];
      for (let i = 0; i < 3; i++) {
        expect(dagArgs.nodes[i].cwd).toBe(manifest.branches[i]!.path);
      }
    });
  });

  describe('validation', () => {
    it('exits 1 for --branches 0', async () => {
      await runFarmCatch({
        task: 'test',
        branches: 0,
        failFast: false,
        _createFarm: vi.fn(),
        _runSubagentDAG: vi.fn(),
        _getCommitCount: vi.fn(),
        _getSourceRepoDirtyFiles: vi.fn(),
      });
      expect(exitCode).toBe(1);
    });

    it('exits 1 for --branches 17', async () => {
      await runFarmCatch({
        task: 'test',
        branches: 17,
        failFast: false,
        _createFarm: vi.fn(),
        _runSubagentDAG: vi.fn(),
        _getCommitCount: vi.fn(),
        _getSourceRepoDirtyFiles: vi.fn(),
      });
      expect(exitCode).toBe(1);
    });

    it('exits 1 when --labels length mismatches --branches', async () => {
      await runFarmCatch({
        task: 'test',
        branches: 3,
        labels: ['a', 'b'], // only 2, but branches=3
        failFast: false,
        _createFarm: vi.fn(),
        _runSubagentDAG: vi.fn(),
        _getCommitCount: vi.fn(),
        _getSourceRepoDirtyFiles: vi.fn(),
      });
      expect(exitCode).toBe(1);
    });

    it('does not dispatch DAG when validation fails', async () => {
      const runDAGMock = vi.fn();
      await runFarmCatch({
        task: 'test',
        branches: 0,
        failFast: false,
        _createFarm: vi.fn(),
        _runSubagentDAG: runDAGMock,
        _getCommitCount: vi.fn(),
        _getSourceRepoDirtyFiles: vi.fn(),
      });
      expect(runDAGMock).not.toHaveBeenCalled();
    });
  });

  describe('createFarm throws', () => {
    it('exits 1 and does not dispatch DAG', async () => {
      const runDAGMock = vi.fn();
      const createFarmMock = vi.fn().mockRejectedValue(new Error('git error'));

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: vi.fn(),
        _getSourceRepoDirtyFiles: vi.fn(),
      });

      expect(exitCode).toBe(1);
      expect(runDAGMock).not.toHaveBeenCalled();
    });
  });

  describe('escape check: source repo dirty after run', () => {
    it('exits 1 and prints isolation violation banner', async () => {
      const manifest = makeManifest(2);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(2));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([' M src/foo.ts']);

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
      });

      expect(exitCode).toBe(1);
      const errorOutput = vi.mocked(console.error).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errorOutput).toMatch(/ISOLATION VIOLATION/);
    });
  });

  describe('escape check: branch with 0 commits', () => {
    it('marks the branch failed when no commits were made', async () => {
      const manifest = makeManifest(2);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(2));
      // branch-1 = 0 commits, branch-2 = 1 commit
      const getCommitCountMock = vi.fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
      });

      // One branch failed (branch-1), so exit code should be 1
      expect(exitCode).toBe(1);
      const logOutput = vi.mocked(console.log).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(logOutput).toMatch(/branch-1.*no commits made/);
    });
  });

  // -------------------------------------------------------------------------
  // Day 3 — scoring integration
  // -------------------------------------------------------------------------

  describe('scoring (Day 3)', () => {
    it('invokes scoreBranch sequentially for each ok branch and writes score.json', async () => {
      const manifest = makeManifest(3);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(3));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);

      // Each branch passes tests; loc_delta varies for ranking.
      const order: number[] = [];
      const scoreBranchMock = vi.fn().mockImplementation(async (opts: {
        branchPath: string;
        baseSha: string;
      }) => {
        // Verify sequential invocation by recording call order.
        const m = /branch-(\d+)/.exec(opts.branchPath);
        const idx = m ? Number(m[1]) : -1;
        order.push(idx);
        return {
          schemaVersion: 1 as const,
          pass: 1,
          fail: 0,
          loc_delta: idx * 10, // branch-1=10, branch-2=20, branch-3=30
          lint_ok: true,
          duration_ms: 100,
          branchPath: opts.branchPath,
          baseSha: opts.baseSha,
          scoredAt: '2026-05-17T00:00:00.000Z',
        };
      });
      const writeScoreMock = vi.fn().mockResolvedValue('/tmp/dummy/score.json');

      await runFarmCatch({
        task: 'test',
        branches: 3,
        failFast: false,
        score: true,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
        _scoreBranch: scoreBranchMock,
        _writeScore: writeScoreMock,
      });

      expect(scoreBranchMock).toHaveBeenCalledTimes(3);
      expect(writeScoreMock).toHaveBeenCalledTimes(3);
      // Sequential invocation: branches scored 1, 2, 3 in order.
      expect(order).toEqual([1, 2, 3]);
      // First call: branchPath, baseSha, timeout passed through correctly.
      expect(scoreBranchMock.mock.calls[0]![0]).toMatchObject({
        branchPath: '/tmp/farm/branch-1',
        baseSha: 'abc123',
      });
    });

    it('skips scoring for branches that failed before scoring (sets score=null)', async () => {
      const manifest = makeManifest(2);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      // branch-1 fails in the DAG; branch-2 succeeds.
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(2, [1]));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);
      const scoreBranchMock = vi.fn().mockResolvedValue({
        schemaVersion: 1, pass: 1, fail: 0, loc_delta: 5, lint_ok: true,
        duration_ms: 50, branchPath: '/tmp/farm/branch-2', baseSha: 'abc123',
        scoredAt: '2026-05-17T00:00:00.000Z',
      });
      const writeScoreMock = vi.fn().mockResolvedValue('');

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        score: true,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
        _scoreBranch: scoreBranchMock,
        _writeScore: writeScoreMock,
      });

      // Only branch-2 (ok) was scored.
      expect(scoreBranchMock).toHaveBeenCalledTimes(1);
      expect(scoreBranchMock.mock.calls[0]![0].branchPath).toBe('/tmp/farm/branch-2');
    });

    it('respects score:false (no scoring invoked)', async () => {
      const manifest = makeManifest(2);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(2));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);
      const scoreBranchMock = vi.fn();
      const writeScoreMock = vi.fn();

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        score: false,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
        _scoreBranch: scoreBranchMock,
        _writeScore: writeScoreMock,
      });

      expect(scoreBranchMock).not.toHaveBeenCalled();
      expect(writeScoreMock).not.toHaveBeenCalled();
    });

    it('propagates scoreTimeoutMs to scoreBranch', async () => {
      const manifest = makeManifest(1);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(1));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);
      const scoreBranchMock = vi.fn().mockResolvedValue({
        schemaVersion: 1, pass: 1, fail: 0, loc_delta: 0, lint_ok: null,
        duration_ms: 0, branchPath: '/tmp/farm/branch-1', baseSha: 'abc123',
        scoredAt: '2026-05-17T00:00:00.000Z',
      });

      await runFarmCatch({
        task: 'test',
        branches: 1,
        failFast: false,
        score: true,
        scoreTimeoutMs: 45_000,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
        _scoreBranch: scoreBranchMock,
        _writeScore: vi.fn().mockResolvedValue(''),
      });

      expect(scoreBranchMock.mock.calls[0]![0].timeoutMs).toBe(45_000);
    });

    it('does not crash farm when writeScore throws (writes are non-fatal)', async () => {
      const manifest = makeManifest(1);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(1));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);
      const scoreBranchMock = vi.fn().mockResolvedValue({
        schemaVersion: 1, pass: 1, fail: 0, loc_delta: 0, lint_ok: true,
        duration_ms: 50, branchPath: '/tmp/farm/branch-1', baseSha: 'abc123',
        scoredAt: '2026-05-17T00:00:00.000Z',
      });
      const writeScoreMock = vi.fn().mockRejectedValue(new Error('EACCES'));

      await runFarmCatch({
        task: 'test',
        branches: 1,
        failFast: false,
        score: true,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
        _scoreBranch: scoreBranchMock,
        _writeScore: writeScoreMock,
      });

      // Farm should still exit 0 (branch succeeded; score persistence is best-effort).
      expect(exitCode).toBe(0);
      // Warning should have been logged.
      const errOutput = vi.mocked(console.error).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errOutput).toMatch(/score\.json write failed/);
    });

    it('prints ranked summary when scoring is enabled', async () => {
      const manifest = makeManifest(2);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const runDAGMock = vi.fn().mockResolvedValue(makeDAGResult(2));
      const getCommitCountMock = vi.fn().mockResolvedValue(1);
      const getDirtyMock = vi.fn().mockResolvedValue([]);
      // branch-1 fails tests; branch-2 passes. Expect branch-2 ranked #1.
      const scoreBranchMock = vi.fn().mockImplementation(async (opts: { branchPath: string }) => {
        const isOne = opts.branchPath.endsWith('branch-1');
        return {
          schemaVersion: 1 as const,
          pass: isOne ? 0 : 1,
          fail: isOne ? 1 : 0,
          loc_delta: 10,
          lint_ok: true,
          duration_ms: 100,
          branchPath: opts.branchPath,
          baseSha: 'abc123',
          scoredAt: '2026-05-17T00:00:00.000Z',
        };
      });

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        score: true,
        _createFarm: createFarmMock,
        _runSubagentDAG: runDAGMock,
        _getCommitCount: getCommitCountMock,
        _getSourceRepoDirtyFiles: getDirtyMock,
        _scoreBranch: scoreBranchMock,
        _writeScore: vi.fn().mockResolvedValue(''),
      });

      const logOutput = vi.mocked(console.log).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      // Ranking marker present on the first listed branch.
      const idxRank1Line = logOutput.indexOf('#1');
      const idxRank2Line = logOutput.indexOf('#2');
      expect(idxRank1Line).toBeGreaterThan(-1);
      expect(idxRank2Line).toBeGreaterThan(idxRank1Line);
      // The ranked-first line should reference branch-2 (the test-passing one).
      const rank1Segment = logOutput.slice(idxRank1Line, idxRank2Line);
      expect(rank1Segment).toMatch(/branch-2/);
    });
  });

  // -------------------------------------------------------------------------
  // Day 4a — memory write-through + Telegram digest
  // -------------------------------------------------------------------------

  describe('memory write-through + digest (Day 4a)', () => {
    function passingScore(idx: number, loc = 10) {
      return {
        schemaVersion: 1 as const,
        pass: 1,
        fail: 0,
        loc_delta: loc,
        lint_ok: true,
        duration_ms: 100,
        branchPath: `/tmp/farm/branch-${idx}`,
        baseSha: 'abc123',
        scoredAt: '2026-05-17T00:00:00.000Z',
      };
    }

    it('writes a farm-run fact when memoryWrite is enabled', async () => {
      const manifest = makeManifest(2);
      const writeFactMock = vi.fn().mockReturnValue({ factId: 42 });

      await runFarmCatch({
        task: 'rewrite auth',
        branches: 2,
        failFast: false,
        score: true,
        memoryWrite: true,
        digest: false,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(2)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _scoreBranch: vi.fn()
          .mockResolvedValueOnce(passingScore(1, 20))
          .mockResolvedValueOnce(passingScore(2, 10)),
        _writeScore: vi.fn().mockResolvedValue(''),
        _writeFarmFact: writeFactMock,
      });

      expect(writeFactMock).toHaveBeenCalledOnce();
      const record = writeFactMock.mock.calls[0]![0];
      // taskName flows from the manifest (createFarm is mocked, fixture hardcodes "test task").
      expect(record.taskName).toBe('test task');
      expect(record.taskSlug).toBe('test-slug');
      expect(record.branches).toHaveLength(2);
      // Winner: branch-2 (lower LoC delta with same pass rate / lint).
      expect(record.winner).toBe(2);
    });

    it('skips memory write when memoryWrite=false', async () => {
      const manifest = makeManifest(1);
      const writeFactMock = vi.fn();

      await runFarmCatch({
        task: 'test',
        branches: 1,
        failFast: false,
        memoryWrite: false,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _writeFarmFact: writeFactMock,
      });

      expect(writeFactMock).not.toHaveBeenCalled();
    });

    it('logs a warning when memory write returns skipped', async () => {
      const manifest = makeManifest(1);
      const writeFactMock = vi.fn().mockReturnValue({ skipped: true, reason: 'db locked' });

      await runFarmCatch({
        task: 'test',
        branches: 1,
        failFast: false,
        memoryWrite: true,
        digest: false,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _writeFarmFact: writeFactMock,
      });

      const errOutput = vi.mocked(console.error).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errOutput).toMatch(/memory.*write skipped.*db locked/);
    });

    it('factId routing: setFarmMemoryFactId called before digest when writeFarmFact returns factId', async () => {
      const manifest = makeManifest(1);
      const mockSetFarmMemoryFactId = vi.fn().mockResolvedValue(undefined);
      const mockSendFarmDigest = vi.fn().mockResolvedValue({ sent: false, reason: 'telegram unconfigured' });

      await runFarmCatch({
        task: 'test task',
        branches: 1,
        failFast: false,
        score: false,
        memoryWrite: true,
        digest: true,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _writeFarmFact: vi.fn().mockReturnValue({ factId: 42 }),
        _sendFarmDigest: mockSendFarmDigest,
        _setFarmMemoryFactId: mockSetFarmMemoryFactId,
      });

      expect(mockSetFarmMemoryFactId).toHaveBeenCalledWith(manifest.taskSlug, 42);
      // Ordering: setFarmMemoryFactId must resolve before sendFarmDigest is called
      expect(mockSetFarmMemoryFactId.mock.invocationCallOrder[0])
        .toBeLessThan(mockSendFarmDigest.mock.invocationCallOrder[0]);
    });

    it('factId routing: setFarmMemoryFactId not called when writeFarmFact returns skipped', async () => {
      const manifest = makeManifest(1);
      const mockSetFarmMemoryFactId = vi.fn();

      await runFarmCatch({
        task: 'test task',
        branches: 1,
        failFast: false,
        score: false,
        memoryWrite: true,
        digest: false,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _writeFarmFact: vi.fn().mockReturnValue({ skipped: true, reason: 'db locked' }),
        _sendFarmDigest: vi.fn().mockResolvedValue({ sent: false, reason: 'telegram unconfigured' }),
        _setFarmMemoryFactId: mockSetFarmMemoryFactId,
      });

      expect(mockSetFarmMemoryFactId).not.toHaveBeenCalled();
    });

    it('sends a Telegram digest when digest is enabled', async () => {
      const manifest = makeManifest(2);
      const digestMock = vi.fn().mockResolvedValue({ sent: true, chatCount: 1 });

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        memoryWrite: false,
        digest: true,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(2)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _sendFarmDigest: digestMock,
      });

      expect(digestMock).toHaveBeenCalledOnce();
      const record = digestMock.mock.calls[0]![0];
      expect(record.taskSlug).toBe('test-slug');
      expect(record.branches).toHaveLength(2);

      const logOutput = vi.mocked(console.log).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(logOutput).toMatch(/telegram.*digest sent.*1 chat/);
    });

    it('skips digest when digest=false', async () => {
      const manifest = makeManifest(1);
      const digestMock = vi.fn();

      await runFarmCatch({
        task: 'test',
        branches: 1,
        failFast: false,
        digest: false,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _sendFarmDigest: digestMock,
      });

      expect(digestMock).not.toHaveBeenCalled();
    });

    it('does not log noise when digest skips with "telegram unconfigured"', async () => {
      const manifest = makeManifest(1);
      const digestMock = vi.fn().mockResolvedValue({ sent: false, reason: 'telegram unconfigured' });

      await runFarmCatch({
        task: 'test',
        branches: 1,
        failFast: false,
        memoryWrite: false,
        digest: true,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _sendFarmDigest: digestMock,
      });

      // "unconfigured" is the expected silent path — should NOT log a warning.
      const errOutput = vi.mocked(console.error).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errOutput).not.toMatch(/digest failed/);
    });

    it('logs a warning when digest sent=false with non-unconfigured reason', async () => {
      const manifest = makeManifest(1);
      const digestMock = vi.fn().mockResolvedValue({ sent: false, reason: 'network timeout' });

      await runFarmCatch({
        task: 'test',
        branches: 1,
        failFast: false,
        memoryWrite: false,
        digest: true,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _sendFarmDigest: digestMock,
      });

      const errOutput = vi.mocked(console.error).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errOutput).toMatch(/telegram.*digest failed.*network timeout/);
    });

    it('record includes winner = undefined when all branches fail', async () => {
      const manifest = makeManifest(2);
      const writeFactMock = vi.fn().mockReturnValue({ factId: 1 });

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        score: false,
        memoryWrite: true,
        digest: false,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        // Both branches fail in the DAG.
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(2, [1, 2])),
        _getCommitCount: vi.fn().mockResolvedValue(0),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _writeFarmFact: writeFactMock,
      });

      const record = writeFactMock.mock.calls[0]![0];
      expect(record.winner).toBeUndefined();
      expect(record.branches.every((b: { ok: boolean }) => !b.ok)).toBe(true);
    });

    it('passes the same record to both memory and digest (single source of truth)', async () => {
      const manifest = makeManifest(2);
      const writeFactMock = vi.fn().mockReturnValue({ factId: 1 });
      const digestMock = vi.fn().mockResolvedValue({ sent: true, chatCount: 1 });

      await runFarmCatch({
        task: 'test',
        branches: 2,
        failFast: false,
        memoryWrite: true,
        digest: true,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(2)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _writeFarmFact: writeFactMock,
        _sendFarmDigest: digestMock,
      });

      // Both received identical taskSlug and branch arrays.
      const memRecord = writeFactMock.mock.calls[0]![0];
      const digestRecord = digestMock.mock.calls[0]![0];
      expect(memRecord.taskSlug).toBe(digestRecord.taskSlug);
      expect(memRecord.branches).toEqual(digestRecord.branches);
      expect(memRecord.startedAt).toBe(digestRecord.startedAt);
    });

    it('logs error when setFarmMemoryFactId rejects but still sends digest', async () => {
      const manifest = makeManifest(1);
      const mockSetFarmMemoryFactId = vi.fn().mockRejectedValue(new Error('id write failed'));
      const digestMock = vi.fn().mockResolvedValue({ sent: true, chatCount: 1 });

      await runFarmCatch({
        task: 'test task',
        branches: 1,
        failFast: false,
        score: false,
        memoryWrite: true,
        digest: true,
        _createFarm: vi.fn().mockResolvedValue(manifest),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult(1)),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _writeFarmFact: vi.fn().mockReturnValue({ factId: 42 }),
        _sendFarmDigest: digestMock,
        _setFarmMemoryFactId: mockSetFarmMemoryFactId,
      });

      // setFarmMemoryFactId was called (and rejected)
      expect(mockSetFarmMemoryFactId).toHaveBeenCalledWith(manifest.taskSlug, 42);
      // The rejection should have been logged as a console.error
      const errOutput = vi.mocked(console.error).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errOutput).toMatch(/id write failed/);
      // Digest should still fire despite the setFarmMemoryFactId rejection
      expect(digestMock).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // R6 — runDAGFn throws: finally block runs AND error propagates
  // -------------------------------------------------------------------------

  /**
   * R6 — `farm` command `process.exit(1)` inside try-catch fires before `finally`.
   *
   * Before the fix, the catch block calls `process.exit(1)` directly. In the
   * test environment, `process.exit` is mocked to throw — so the `finally`
   * block that calls `abortController.abort()` is never reached.
   *
   * After the fix, `process.exit(1)` is replaced with `throw err`. The `finally`
   * block runs (because `throw` unwinds through finally), and the error
   * propagates to the Commander action handler (or test caller).
   *
   * We verify:
   *   1. The `abortController.abort()` in the `finally` block IS called
   *      (by using a custom `_runSubagentDAG` that captures the abort signal).
   *   2. `runFarm` rejects (throws) rather than silently exiting.
   *   3. `process.exit(1)` is NOT called (the mocked exit should not fire).
   */
  describe('R6 — runDAGFn throws: finally runs and error propagates', () => {
    it('(R6-1) finally block abortController.abort() is called when DAG throws', async () => {
      const manifest = makeManifest(2);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);

      let capturedSignal: AbortSignal | undefined;
      const throwingDAGMock = vi.fn().mockImplementation(
        ({ parentSession }: { manager: unknown; parentSession: { abortSignal: AbortSignal }; nodes: unknown[]; edges: unknown[]; failFast: boolean }) => {
          capturedSignal = parentSession.abortSignal;
          return Promise.reject(new Error('DAG exploded'));
        },
      );

      let caughtError: Error | undefined;
      try {
        await runFarm({
          task: 'test',
          branches: 2,
          failFast: false,
          score: false,
          memoryWrite: false,
          digest: false,
          _createFarm: createFarmMock,
          _runSubagentDAG: throwingDAGMock,
          _getCommitCount: vi.fn(),
          _getSourceRepoDirtyFiles: vi.fn(),
        });
      } catch (err) {
        caughtError = err instanceof Error ? err : new Error(String(err));
      }

      // After fix: error propagates (runFarm throws)
      expect(caughtError).toBeDefined();
      expect(caughtError?.message).toMatch(/DAG exploded/);

      // After fix: process.exit was NOT called (mocked exit would throw 'process.exit(1)')
      expect(exitCode).toBeUndefined();

      // After fix: the finally block ran, so capturedSignal.aborted must be true
      // (abortController.abort() is called in finally before throw unwinds)
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('(R6-2) error message is surfaced (console.error called before throw)', async () => {
      const manifest = makeManifest(1);
      const createFarmMock = vi.fn().mockResolvedValue(manifest);
      const throwingDAGMock = vi.fn().mockRejectedValue(new Error('dispatch failure'));

      try {
        await runFarm({
          task: 'test',
          branches: 1,
          failFast: false,
          score: false,
          memoryWrite: false,
          digest: false,
          _createFarm: createFarmMock,
          _runSubagentDAG: throwingDAGMock,
          _getCommitCount: vi.fn(),
          _getSourceRepoDirtyFiles: vi.fn(),
        });
      } catch {
        // expected
      }

      const errOutput = vi.mocked(console.error).mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errOutput).toMatch(/dispatch failure/);
    });
  });
});
