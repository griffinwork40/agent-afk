/**
 * Isolation tests for the `isolation: "worktree"` wiring in
 * {@link runSubagentDAG}.
 *
 * PR #2104 added ~50 lines of worktree isolation logic to `dag-subagent.ts`:
 * worktree creation, cwd override, budget rollback on failure, and teardown in
 * the finally block. This suite tests THAT logic at the executor seam — it does
 * not test the underlying worktree primitives themselves (those are covered in
 * `handlers/worktree.test.ts` and `handlers/worktree-managed.test.ts`).
 *
 * The isolation pipeline in `dag-subagent.ts`:
 *   1. If `isolation:"worktree"` on a node, call `createIsolatedWorktree({cwd, slugHint})`
 *   2. On success: override `spec.cwd = iso.path`, record `isolationTeardown`
 *   3. On `createIsolatedWorktree` throw: rollback budget receipt, rethrow with
 *      a descriptive message — never silently fall back to the shared tree
 *   4. On fork failure after creation: call `teardownBackgroundWorktree` in catch
 *   5. After node finishes (success or failure): call `teardownBackgroundWorktree`
 *      in the finally block
 *
 * Seams mocked (testing executor logic, not git and not a real child):
 *   - `./tools/handlers/worktree-managed.js` — `createIsolatedWorktree` as vi.fn()
 *   - `./tools/handlers/worktree-managed.background.js` — `teardownBackgroundWorktree` as vi.fn()
 *   - `../utils/debug.js` — `debugLog` to silence noise
 *
 * Reference: `src/agent/tools/subagent/subagent-executor.isolation.test.ts`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (must precede the runSubagentDAG import) -----------------

vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

// Worktree creation primitive — what isolation:"worktree" calls to create the tree.
const createIsolatedWorktree = vi.hoisted(() => vi.fn());
vi.mock('./tools/handlers/worktree-managed.js', () => ({
  createIsolatedWorktree,
  teardownIsolatedWorktree: vi.fn().mockResolvedValue({ removed: true, preserved: false }),
}));

// Teardown primitive — called in the catch block (fork failure after creation)
// and in the finally block (after node completion).
const teardownBackgroundWorktree = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ removed: true, preserved: false }),
);
vi.mock('./tools/handlers/worktree-managed.background.js', () => ({
  teardownBackgroundWorktree,
  lockWorktreeForBackground: vi.fn().mockResolvedValue(undefined),
  unlockWorktreeForPromotion: vi.fn().mockResolvedValue(undefined),
}));

import { runSubagentDAG, type SubagentDAGNode } from './dag-subagent.js';
import type { SubagentManager } from './subagent.js';
import type { IAgentSession, Message } from './types.js';
import { DelegationBudget } from './tools/delegation-budget.js';

// --- Shared test harness ----------------------------------------------------

/** Shape returned by createIsolatedWorktree on success. */
const ISO_RESULT = {
  path: '/repo/.afk-worktrees/iso-compose-nodeA-1-abc123',
  branch: 'afk/iso-compose-nodeA-1-abc123',
  baseRef: 'HEAD',
  baseSha: 'deadbeef',
  repoRoot: '/repo',
};

interface FakeHandle {
  runToResult: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  cancel?: ReturnType<typeof vi.fn>;
}

function makeFakeHandle(reply: string | Error): FakeHandle {
  return {
    runToResult: vi.fn(async (): Promise<{
      id: string;
      status: string;
      message?: Message;
      error?: Error;
    }> => {
      if (reply instanceof Error) {
        return { id: 'fake', status: 'failed', error: reply };
      }
      return {
        id: 'fake',
        status: 'succeeded',
        message: { role: 'assistant' as const, content: reply, timestamp: new Date() },
      };
    }),
    teardown: vi.fn(async () => undefined),
  };
}

function makeParent(): Pick<IAgentSession, 'sessionId' | 'abortSignal'> {
  return {
    sessionId: 'test-parent',
    abortSignal: new AbortController().signal,
  };
}

function makeNode(overrides?: Partial<SubagentDAGNode>): SubagentDAGNode {
  return {
    id: 'nodeA',
    systemPrompt: 'You are a test agent',
    promptBuilder: () => 'do something',
    ...overrides,
  };
}

function makeManager(handle: FakeHandle): SubagentManager {
  return {
    forkSubagent: vi.fn(async () => handle),
  } as unknown as SubagentManager;
}

// ---------------------------------------------------------------------------

describe('runSubagentDAG — isolation:"worktree" wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore benign defaults after clearAllMocks.
    teardownBackgroundWorktree.mockResolvedValue({ removed: true, preserved: false });
    createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
  });

  // -------------------------------------------------------------------------
  // (1) Happy path: worktree created, fork cwd rewritten to worktree path,
  //     teardown fires in the finally block after successful completion.
  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('creates the worktree once, rewrites node cwd, and tears down in finally', async () => {
      const handle = makeFakeHandle('done');
      const manager = makeManager(handle);

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
      });

      // Node succeeded.
      expect(result.failed).toHaveLength(0);
      expect(result.outputs['nodeA']).toBe('done');

      // createIsolatedWorktree called exactly once with the anchor cwd.
      expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);
      const createArg = createIsolatedWorktree.mock.calls[0]![0] as {
        cwd: string;
        slugHint: string;
      };
      expect(createArg.cwd).toBe('/repo');
      // Slug matches the compose-specific pattern: iso-compose-<nodeId>-<counter>-<random>.
      expect(createArg.slugHint).toMatch(/^iso-compose-nodeA-\d+-[a-z0-9]+$/);

      // The fork received the worktree path as cwd.
      const forkSpy = manager.forkSubagent as unknown as ReturnType<typeof vi.fn>;
      expect(forkSpy).toHaveBeenCalledTimes(1);
      const forkArg = forkSpy.mock.calls[0]![0] as { config: { cwd?: string } };
      expect(forkArg.config.cwd).toBe(ISO_RESULT.path);

      // teardownBackgroundWorktree fires in the finally block.
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
      const tdArg = teardownBackgroundWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      expect(tdArg.repoRoot).toBe(ISO_RESULT.repoRoot);
      expect(tdArg.worktreePath).toBe(ISO_RESULT.path);
    });

    it('uses process.cwd() as the anchor when anchorCwd is not supplied', async () => {
      const handle = makeFakeHandle('ok');
      const manager = makeManager(handle);

      await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        // anchorCwd intentionally absent
      });

      expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);
      const createArg = createIsolatedWorktree.mock.calls[0]![0] as { cwd: string };
      // Falls back to process.cwd() — just verify it is a non-empty string.
      expect(typeof createArg.cwd).toBe('string');
      expect(createArg.cwd.length).toBeGreaterThan(0);
    });

    it('generates distinct slug hints for consecutive isolated nodes (monotonic counter)', async () => {
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => makeFakeHandle('ok')),
      } as unknown as SubagentManager;

      // Two sequential nodes — chain them so they run in order.
      await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [
          makeNode({ id: 'A', isolation: 'worktree' }),
          makeNode({ id: 'B', isolation: 'worktree' }),
        ],
        edges: [{ from: 'A', to: 'B' }],
        anchorCwd: '/repo',
      });

      expect(createIsolatedWorktree).toHaveBeenCalledTimes(2);
      const slug0 = (createIsolatedWorktree.mock.calls[0]![0] as { slugHint: string }).slugHint;
      const slug1 = (createIsolatedWorktree.mock.calls[1]![0] as { slugHint: string }).slugHint;
      // Slug includes the counter — two calls must produce different slugs.
      expect(slug0).not.toBe(slug1);
    });

    it('does NOT create a worktree when isolation is absent (default behaviour)', async () => {
      const handle = makeFakeHandle('ok');
      const manager = makeManager(handle);

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: undefined })],
        edges: [],
        anchorCwd: '/repo',
      });

      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
      expect(result.failed).toHaveLength(0);
    });

    it('does NOT create a worktree when isolation is "none"', async () => {
      const handle = makeFakeHandle('ok');
      const manager = makeManager(handle);

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'none' })],
        edges: [],
        anchorCwd: '/repo',
      });

      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
      expect(result.failed).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // (2) createIsolatedWorktree throws → fail loud, rollback budget receipt,
  //     no fork, no teardown attempt.
  // -------------------------------------------------------------------------
  describe('createIsolatedWorktree throws (creation failure)', () => {
    it('surfaces a descriptive error and never forks when creation fails', async () => {
      createIsolatedWorktree.mockRejectedValue(new Error('Not in a git repository.'));

      const handle = makeFakeHandle('should not run');
      const manager = makeManager(handle);

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
      });

      // The DAG records the failure (runDAG catches the thrown error).
      expect(result.failed).toHaveLength(1);
      const err = result.failed[0]!.error;

      // Error message must mention "isolated worktree" and the original message.
      expect(err.message).toContain('isolated worktree');
      expect(err.message).toContain('Not in a git repository.');

      // No fork happened — the node never ran.
      const forkSpy = manager.forkSubagent as unknown as ReturnType<typeof vi.fn>;
      expect(forkSpy).not.toHaveBeenCalled();

      // No teardown attempt — nothing to tear down.
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });

    it('rolls back the delegation budget receipt when creation fails', async () => {
      createIsolatedWorktree.mockRejectedValue(new Error('git unavailable'));
      const budget = new DelegationBudget({ maxTotalAgents: 10 });
      const rollbackSpy = vi.fn();

      // Spy on recordSpawn to intercept the receipt and capture rollback.
      const origRecord = budget.recordSpawn.bind(budget);
      vi.spyOn(budget, 'recordSpawn').mockImplementation((...args) => {
        const receipt = origRecord(...args);
        const origRollback = receipt.rollback.bind(receipt);
        receipt.rollback = vi.fn(() => {
          rollbackSpy();
          origRollback();
        });
        return receipt;
      });

      await runSubagentDAG({
        manager: {
          forkSubagent: vi.fn(async () => makeFakeHandle('nope')),
        } as unknown as SubagentManager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
        delegationBudget: budget,
      });

      // The budget receipt must have been rolled back (child never ran).
      expect(rollbackSpy).toHaveBeenCalledTimes(1);
      // Total stays 0 — the spawn was recorded then rolled back.
      const snap = budget.snapshot();
      expect(snap.total).toBe(0);
      expect(snap.concurrent).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // (3) Fork fails after worktree creation → teardown fires in the catch block.
  // -------------------------------------------------------------------------
  describe('fork failure after worktree creation', () => {
    it('calls teardownBackgroundWorktree in the catch block when forkSubagent throws', async () => {
      const forkError = new Error('forkSubagent failed after worktree was created');
      const failingManager: SubagentManager = {
        forkSubagent: vi.fn(async () => {
          throw forkError;
        }),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager: failingManager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
      });

      // Worktree WAS created (before fork).
      expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);

      // Teardown fires even though the fork failed.
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
      const tdArg = teardownBackgroundWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      expect(tdArg.repoRoot).toBe(ISO_RESULT.repoRoot);
      expect(tdArg.worktreePath).toBe(ISO_RESULT.path);

      // The fork error propagates as a DAG failure.
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toBe(forkError);
    });

    it('does NOT call teardownBackgroundWorktree in the catch block when no worktree was created', async () => {
      // No isolation — creation never runs, so catch block has no isolationTeardown.
      const forkError = new Error('fork failed, no worktree');
      const failingManager: SubagentManager = {
        forkSubagent: vi.fn(async () => {
          throw forkError;
        }),
      } as unknown as SubagentManager;

      await runSubagentDAG({
        manager: failingManager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: undefined })],
        edges: [],
        anchorCwd: '/repo',
      });

      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (4) Teardown fires in the finally block after a successful run, and also
  //     after a failed run (node returns non-succeeded status).
  // -------------------------------------------------------------------------
  describe('teardown in the finally block', () => {
    it('calls teardownBackgroundWorktree in finally after a successful run', async () => {
      const handle = makeFakeHandle('success result');
      const manager = makeManager(handle);

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
      });

      expect(result.failed).toHaveLength(0);
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);

      // Teardown receives the correct coordinates from the create result.
      const tdArg = teardownBackgroundWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      expect(tdArg).toEqual({
        repoRoot: ISO_RESULT.repoRoot,
        worktreePath: ISO_RESULT.path,
      });
    });

    it('calls teardownBackgroundWorktree in finally even when the subagent run fails', async () => {
      const handle = makeFakeHandle(new Error('subagent failed mid-run'));
      const manager = makeManager(handle);

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
      });

      // Node failed, but teardown still fires.
      expect(result.failed).toHaveLength(1);
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
      const tdArg = teardownBackgroundWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      expect(tdArg.repoRoot).toBe(ISO_RESULT.repoRoot);
      expect(tdArg.worktreePath).toBe(ISO_RESULT.path);
    });

    it('teardownBackgroundWorktree receives worktreePath == the path set on the fork cwd', async () => {
      // Pin that the cwd written to forkSubagent and the path passed to
      // teardownBackgroundWorktree come from the same ISO_RESULT.path — they
      // are not independently derived.
      createIsolatedWorktree.mockResolvedValue({
        ...ISO_RESULT,
        path: '/repo/.afk-worktrees/iso-compose-nodeA-1-xyz789',
        repoRoot: '/repo',
      });

      const handle = makeFakeHandle('done');
      const manager = makeManager(handle);

      await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
      });

      const forkSpy = manager.forkSubagent as unknown as ReturnType<typeof vi.fn>;
      const forkCwd = (forkSpy.mock.calls[0]![0] as { config: { cwd?: string } }).config.cwd;
      const tdWorktreePath = (teardownBackgroundWorktree.mock.calls[0]![0] as { worktreePath: string }).worktreePath;

      // Both must be the same path from createIsolatedWorktree.
      expect(forkCwd).toBe('/repo/.afk-worktrees/iso-compose-nodeA-1-xyz789');
      expect(tdWorktreePath).toBe(forkCwd);
    });

    it('does NOT call teardownBackgroundWorktree in finally when isolation was not requested', async () => {
      const handle = makeFakeHandle('no-iso');
      const manager = makeManager(handle);

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: undefined })],
        edges: [],
      });

      expect(result.failed).toHaveLength(0);
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });

    it('teardown errors are swallowed (finally .catch(() => undefined))', async () => {
      // Tear down that throws must not propagate — the node result should still
      // be surfaced normally and not replaced by the teardown error.
      teardownBackgroundWorktree.mockRejectedValue(new Error('teardown exploded'));

      const handle = makeFakeHandle('node-output');
      const manager = makeManager(handle);

      // Should not throw, and the node result must survive.
      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeNode({ isolation: 'worktree' })],
        edges: [],
        anchorCwd: '/repo',
      });

      expect(result.failed).toHaveLength(0);
      expect(result.outputs['nodeA']).toBe('node-output');
      // Teardown was called (even if it threw).
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
    });
  });
});
