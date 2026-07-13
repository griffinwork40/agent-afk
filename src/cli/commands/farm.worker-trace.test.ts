/**
 * Integration tests verifying that farm worker sessions inherit traceWriter
 * and surface from the SubagentManager.
 *
 * These tests sit at the boundary between farm.ts and SubagentManager: they
 * mock SubagentManager to capture constructor options, then verify that:
 *   1. farm passes `surface: 'cli'` to the SubagentManager constructor, AND
 *   2. SubagentManager propagates traceWriter + surface into forked worker
 *      configs (covered more granularly in subagent.test.ts).
 *
 * Complementary to the unit tests in subagent.test.ts which test the
 * inheritance mechanism directly.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FarmManifest, CreatedBranch } from '../../agent/worktree.js';
import type { DAGRunResult } from '../../agent/dag.js';

// ---------------------------------------------------------------------------
// Shared state for capturing SubagentManager constructor options
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => ({
  lastManagerOptions: null as Record<string, unknown> | null,
}));

vi.mock('../../agent/subagent.js', () => ({
  // Invariant: this mock must capture constructor options without calling
  // any real SubagentManager methods. Farm only passes the manager to
  // runSubagentDAG (via _runSubagentDAG injection) — no methods are called
  // directly by farm.ts itself.
  SubagentManager: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    shared.lastManagerOptions = opts ?? {};
    return {};
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBranch(index: number): CreatedBranch {
  return {
    index,
    path: `/tmp/farm/branch-${index}`,
    branch: `afk/farm/test-slug/${index}-branch-${index}`,
  };
}

function makeManifest(count: number): FarmManifest {
  const branches = Array.from({ length: count }, (_, i) => makeBranch(i + 1));
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

function makeDAGResult(): DAGRunResult {
  return { outputs: {}, failed: [], skipped: [] };
}

// ---------------------------------------------------------------------------
// Import after mocks are hoisted
// ---------------------------------------------------------------------------

import { runFarm } from './farm.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('farm → SubagentManager worker-trace wiring', () => {
  it('passes surface: "cli" to the SubagentManager constructor', async () => {
    shared.lastManagerOptions = null;

    const vi_console_log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const vi_console_error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runFarm({
        task: 'test',
        branches: 1,
        failFast: false,
        score: false,
        memoryWrite: false,
        digest: false,
        _createFarm: vi.fn().mockResolvedValue(makeManifest(1)),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult()),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _createTraceWriter: vi.fn().mockReturnValue(null),
      });
    } catch {
      // process.exit throws in some test environments; swallow it
    } finally {
      vi_console_log.mockRestore();
      vi_console_error.mockRestore();
    }

    expect(shared.lastManagerOptions).not.toBeNull();
    expect(shared.lastManagerOptions).toMatchObject({ surface: 'cli' });
  });

  it('passes traceWriter from _createTraceWriter into the SubagentManager constructor', async () => {
    shared.lastManagerOptions = null;

    const fakeWriter = { write: vi.fn(), close: vi.fn(), getTracePath: vi.fn() };
    const createTraceWriterMock = vi.fn().mockReturnValue({
      writer: fakeWriter,
      tracePath: '/tmp/trace.jsonl',
      sessionLabel: 'test-label',
    });

    const vi_console_log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const vi_console_error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runFarm({
        task: 'test',
        branches: 1,
        failFast: false,
        score: false,
        memoryWrite: false,
        digest: false,
        _createFarm: vi.fn().mockResolvedValue(makeManifest(1)),
        _runSubagentDAG: vi.fn().mockResolvedValue(makeDAGResult()),
        _getCommitCount: vi.fn().mockResolvedValue(1),
        _getSourceRepoDirtyFiles: vi.fn().mockResolvedValue([]),
        _createTraceWriter: createTraceWriterMock,
      });
    } catch {
      // swallow process.exit
    } finally {
      vi_console_log.mockRestore();
      vi_console_error.mockRestore();
    }

    expect(shared.lastManagerOptions).not.toBeNull();
    expect(shared.lastManagerOptions).toMatchObject({ traceWriter: fakeWriter });
  });
});
