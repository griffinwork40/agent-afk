/**
 * Integration tests for the `isolation: "worktree"` wiring in
 * {@link runSubagentDAG} / `dag-subagent.ts`.
 *
 * PR #2104 added ~50 lines of runtime isolation logic (worktree creation,
 * cwd override, budget rollback on failure, teardown in the finally block)
 * with zero unit test coverage. This suite closes that gap.
 *
 * The four required scenarios from issue #2118:
 *   1. Happy path: worktree created, fork config `cwd` equals the mocked
 *      worktree path.
 *   2. Creation failure: budget receipt rolled back, error thrown with
 *      descriptive message containing "isolated worktree".
 *   3. Fork failure after creation: teardown fires in the catch block.
 *   4. Successful run completion: teardown fires in the finally block.
 *
 * Seams mocked:
 *   - `./tools/handlers/worktree-managed.js` — `createIsolatedWorktree` as a
 *     `vi.fn()` so no git subprocess runs.
 *   - `./tools/handlers/worktree-managed.background.js` —
 *     `teardownBackgroundWorktree` as a `vi.fn()` so no git subprocess runs.
 *
 * The subagent manager and its handle are faked inline (same pattern as
 * dag-subagent.test.ts) — no real child session is driven.
 *
 * Reference: `src/agent/tools/subagent/subagent-executor.isolation.test.ts`
 * for the analogous agent-tool pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentManager } from './subagent.js';
import type { IAgentSession, Message } from './types.js';
import { DelegationBudget } from './tools/delegation-budget.js';

vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede the runSubagentDAG import so vi.mock() can
// intercept the module before dag-subagent.ts resolves its own imports.
// ---------------------------------------------------------------------------

const createIsolatedWorktree = vi.hoisted(() => vi.fn());
vi.mock('./tools/handlers/worktree-managed.js', () => ({
  createIsolatedWorktree,
  // dag-subagent.ts only imports createIsolatedWorktree from this module.
  // Other exports are unused on this path, so we omit them.
}));

const teardownBackgroundWorktree = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock('./tools/handlers/worktree-managed.background.js', () => ({
  teardownBackgroundWorktree,
}));

import { runSubagentDAG, type SubagentDAGNode } from './dag-subagent.js';

// ---------------------------------------------------------------------------
// Shared test harness (mirrors dag-subagent.test.ts helpers)
// ---------------------------------------------------------------------------

/** Shape returned by the real createIsolatedWorktree. */
const ISO_RESULT = {
  path: '/repo/.afk-worktrees/iso-compose-A-1-abc123',
  branch: 'afk/iso-compose-A-1-abc123',
  baseRef: 'HEAD',
  baseSha: 'deadbeef',
  repoRoot: '/repo',
};

interface FakeHandle {
  runToResult: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
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
    cancel: vi.fn(async () => undefined),
  };
}

function makeParent(): Pick<IAgentSession, 'sessionId' | 'abortSignal'> {
  return {
    sessionId: 'test-parent',
    abortSignal: new AbortController().signal,
  };
}

/** Minimal node spec with isolation:"worktree". */
function makeIsoNode(id = 'A'): SubagentDAGNode {
  return {
    id,
    systemPrompt: 'You are a test agent',
    promptBuilder: () => 'do something',
    isolation: 'worktree',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSubagentDAG — isolation:"worktree" wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore benign default for teardown.
    teardownBackgroundWorktree.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // (1) Happy path: worktree created, fork config cwd === worktree path.
  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('creates the worktree once and rewrites the fork config cwd to the worktree path', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const handle = makeFakeHandle('ok');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/repo',
      });

      // DAG should succeed.
      expect(result.failed).toHaveLength(0);
      expect(result.outputs['A']).toBe('ok');

      // createIsolatedWorktree was called exactly once, anchored at anchorCwd.
      expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);
      const createArg = createIsolatedWorktree.mock.calls[0]![0] as {
        cwd: string;
        slugHint: string;
      };
      expect(createArg.cwd).toBe('/repo');
      // Slug hint follows the iso-compose-<id>-<counter>-<rand> pattern.
      expect(createArg.slugHint).toMatch(/^iso-compose-A-\d+-[a-z0-9]+$/);

      // The fork config must carry cwd = the worktree path, not the anchor.
      const forkSpy = manager.forkSubagent as ReturnType<typeof vi.fn>;
      expect(forkSpy).toHaveBeenCalledTimes(1);
      const forkArg = forkSpy.mock.calls[0]![0] as { config: { cwd?: string } };
      expect(forkArg.config.cwd).toBe(ISO_RESULT.path);
    });

    it('gives concurrent nodes distinct slug hints (monotonic dagIsolationCounter)', async () => {
      // Two sequential nodes in the same DAG invocation must not collide slugs.
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const manager: SubagentManager = {
        forkSubagent: vi.fn()
          .mockResolvedValueOnce(makeFakeHandle('ok-A'))
          .mockResolvedValueOnce(makeFakeHandle('ok-B')),
      } as unknown as SubagentManager;

      await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A'), makeIsoNode('B')],
        edges: [{ from: 'A', to: 'B' }], // sequential — keeps assertions deterministic
        anchorCwd: '/repo',
      });

      expect(createIsolatedWorktree).toHaveBeenCalledTimes(2);
      const slug0 = (createIsolatedWorktree.mock.calls[0]![0] as { slugHint: string }).slugHint;
      const slug1 = (createIsolatedWorktree.mock.calls[1]![0] as { slugHint: string }).slugHint;
      expect(slug0).not.toBe(slug1);
    });

    it('uses process.cwd() as the anchor when anchorCwd is not supplied', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const handle = makeFakeHandle('ok');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        // anchorCwd intentionally absent — should fall back to process.cwd()
      });

      expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);
      const createArg = createIsolatedWorktree.mock.calls[0]![0] as { cwd: string };
      // The cwd passed to createIsolatedWorktree must be the real process.cwd()
      // value, not anchorCwd (which was never supplied).
      expect(createArg.cwd).toBe(process.cwd());
    });

    it('does NOT create a worktree when isolation is "none" (explicit no-op)', async () => {
      const handle = makeFakeHandle('plain');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{
          id: 'A',
          systemPrompt: 's',
          promptBuilder: () => 'p',
          isolation: 'none',
        }],
        edges: [],
        anchorCwd: '/repo',
      });

      expect(result.failed).toHaveLength(0);
      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (2) Creation failure: budget receipt rolled back, error thrown with
  //     descriptive message containing "isolated worktree".
  // -------------------------------------------------------------------------
  describe('createIsolatedWorktree throws (non-git cwd)', () => {
    it('rolls back the budget receipt and surfaces an error mentioning "isolated worktree"', async () => {
      createIsolatedWorktree.mockRejectedValue(new Error('Not in a git repository.'));

      const budget = new DelegationBudget({ maxTotalAgents: 10 });
      const rollbackSpy = vi.spyOn(budget, 'recordSpawn');

      const manager: SubagentManager = {
        forkSubagent: vi.fn(),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/tmp/not-a-git-repo',
        delegationBudget: budget,
      });

      // The node must fail with a descriptive message.
      expect(result.failed).toHaveLength(1);
      const err = result.failed[0]!.error;
      expect(err.message).toContain('isolated worktree');
      expect(err.message).toContain('A');
      expect(err.message).toContain('Not in a git repository.');

      // No fork happened after the creation failure.
      expect(manager.forkSubagent).not.toHaveBeenCalled();

      // Budget must be rolled back: the child never ran, so total should be 0.
      // recordSpawn returns a receipt; that receipt's rollback() must have been
      // called. Verify via budget snapshot (total = 0, concurrent = 0).
      const snap = budget.snapshot();
      expect(snap.total).toBe(0);
      expect(snap.concurrent).toBe(0);

      // Teardown must NOT be called — there is no worktree to tear down.
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });

    it('fails loud: never silently falls back to the shared tree', async () => {
      createIsolatedWorktree.mockRejectedValue(new Error('git error'));

      const manager: SubagentManager = {
        forkSubagent: vi.fn(),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
      });

      // The node must fail — not silently succeed by falling back to the parent tree.
      expect(result.failed).toHaveLength(1);
      // forkSubagent was never called, confirming no fallback fork happened.
      expect(manager.forkSubagent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (3) Fork failure after creation: teardown fires in the catch block.
  // -------------------------------------------------------------------------
  describe('fork failure after creation', () => {
    it('calls teardownBackgroundWorktree in the catch block when forkSubagent throws', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);

      const forkError = new Error('fork failed');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => {
          throw forkError;
        }),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/repo',
      });

      // Node fails with the fork error.
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toBe(forkError);

      // The worktree was created before the fork — teardown must fire to clean up.
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
      const tdArg = teardownBackgroundWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      expect(tdArg.repoRoot).toBe(ISO_RESULT.repoRoot);
      expect(tdArg.worktreePath).toBe(ISO_RESULT.path);
    });

    it('rolls back the budget receipt when forkSubagent throws after worktree creation', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);

      const budget = new DelegationBudget({ maxTotalAgents: 10 });
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => {
          throw new Error('fork error');
        }),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/repo',
        delegationBudget: budget,
      });

      expect(result.failed).toHaveLength(1);

      // Budget rolled back: child never ran.
      const snap = budget.snapshot();
      expect(snap.total).toBe(0);
      expect(snap.concurrent).toBe(0);
    });

    it('does NOT call teardownBackgroundWorktree in the catch block when no worktree was created', async () => {
      // isolation is absent — createIsolatedWorktree never runs, so isolationTeardown
      // stays undefined, and the catch block must not attempt teardown.
      const forkError = new Error('fork failed, no worktree involved');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => {
          throw forkError;
        }),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{
          id: 'A',
          systemPrompt: 's',
          promptBuilder: () => 'p',
          // isolation absent — no worktree is ever created
        }],
        edges: [],
        anchorCwd: '/repo',
      });

      // The node fails (forkSubagent threw), but teardown must NOT be called
      // because no worktree was created.
      expect(result.failed).toHaveLength(1);
      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (4) Successful run completion: teardown fires in the finally block.
  // -------------------------------------------------------------------------
  describe('successful run — teardown in finally block', () => {
    it('calls teardownBackgroundWorktree after the node succeeds', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const handle = makeFakeHandle('result');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/repo',
      });

      expect(result.failed).toHaveLength(0);
      expect(result.outputs['A']).toBe('result');

      // Teardown fires in the finally block after the node run completes.
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
      const tdArg = teardownBackgroundWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      expect(tdArg.repoRoot).toBe(ISO_RESULT.repoRoot);
      expect(tdArg.worktreePath).toBe(ISO_RESULT.path);
    });

    it('threads exactly { repoRoot, worktreePath } from the create result into teardown', async () => {
      const customIso = {
        ...ISO_RESULT,
        path: '/repo/.afk-worktrees/iso-compose-X-42-zyx987',
        repoRoot: '/custom-repo',
      };
      createIsolatedWorktree.mockResolvedValue(customIso);
      const handle = makeFakeHandle('ok');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/custom-repo',
      });

      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
      const tdArg = teardownBackgroundWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      // repoRoot and worktreePath must come from the create result, not from anchorCwd.
      expect(tdArg.repoRoot).toBe('/custom-repo');
      expect(tdArg.worktreePath).toBe('/repo/.afk-worktrees/iso-compose-X-42-zyx987');
    });

    it('calls teardown even when the node run fails (finally always fires)', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const handle = makeFakeHandle(new Error('node-run-error'));
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/repo',
      });

      // The node failed, but teardown still fires (finally block).
      expect(result.failed).toHaveLength(1);
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
    });

    it('teardown errors are swallowed — a rejection from teardownBackgroundWorktree does not propagate', async () => {
      // The finally block uses .catch(() => undefined) — a teardown rejection must
      // never replace or mask the node's own result.
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      teardownBackgroundWorktree.mockRejectedValue(new Error('teardown exploded'));

      const handle = makeFakeHandle('node-output');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      // Must not throw despite the teardown rejection.
      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/repo',
      });

      // The node result survives — teardown error did not propagate.
      expect(result.failed).toHaveLength(0);
      expect(result.outputs['A']).toBe('node-output');
      // Teardown was called (even though it rejected).
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
    });

    it('does NOT call createIsolatedWorktree or teardown for nodes without isolation', async () => {
      const handle = makeFakeHandle('plain');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        // No isolation field — defaults to undefined (treated as "none").
        nodes: [{
          id: 'A',
          systemPrompt: 's',
          promptBuilder: () => 'p',
        }],
        edges: [],
      });

      expect(result.failed).toHaveLength(0);
      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // (5) process.cwd() fallback — when anchorCwd is absent, createIsolatedWorktree
    //     receives process.cwd() as its cwd argument.
    // -------------------------------------------------------------------------
    it('uses process.cwd() as the worktree anchor when anchorCwd is not supplied', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const handle = makeFakeHandle('ok');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      // Omit anchorCwd entirely — the production code falls back to process.cwd().
      await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        // anchorCwd intentionally absent
      });

      expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);
      const createArg = createIsolatedWorktree.mock.calls[0]![0] as { cwd: string };
      // The cwd passed to createIsolatedWorktree must be the real process.cwd()
      // value, not anchorCwd (which was never supplied).
      expect(createArg.cwd).toBe(process.cwd());
    });

    // -------------------------------------------------------------------------
    // (6) isolation:"none" no-op — explicit "none" does NOT create a worktree,
    //     distinct from the "isolation absent" test above.
    // -------------------------------------------------------------------------
    it('does NOT call createIsolatedWorktree or teardown when isolation is "none"', async () => {
      const handle = makeFakeHandle('plain');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        // Explicit isolation:"none" — must be treated as a no-op, not "worktree".
        nodes: [{
          id: 'A',
          systemPrompt: 's',
          promptBuilder: () => 'p',
          isolation: 'none',
        }],
        edges: [],
      });

      expect(result.failed).toHaveLength(0);
      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // (7) Catch block skips teardown when no worktree was created — if
    //     forkSubagent throws but createIsolatedWorktree was never called
    //     (e.g. budget exhaustion before creation), teardown is not invoked.
    // -------------------------------------------------------------------------
    it('does not call teardown in the catch block when no worktree was ever created', async () => {
      // Use a non-worktree node so createIsolatedWorktree is never called,
      // but make forkSubagent throw so we exercise the catch path.
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => {
          throw new Error('fork failed without worktree');
        }),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{
          id: 'A',
          systemPrompt: 's',
          promptBuilder: () => 'p',
          // No isolation — isolationTeardown stays undefined.
        }],
        edges: [],
      });

      // The node fails (forkSubagent threw), but teardown must NOT be called
      // because no worktree was created.
      expect(result.failed).toHaveLength(1);
      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(teardownBackgroundWorktree).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // (8) Teardown errors are swallowed — a rejection from
    //     teardownBackgroundWorktree in the finally block does not propagate.
    // -------------------------------------------------------------------------
    it('swallows teardown errors from the finally block (.catch(() => undefined) pattern)', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      // Make teardown reject to verify the error is swallowed.
      teardownBackgroundWorktree.mockRejectedValue(new Error('teardown boom'));

      const handle = makeFakeHandle('ok');
      const manager: SubagentManager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      // If the teardown error propagated, runSubagentDAG would throw (or reject).
      // The test verifies it completes normally and the node output is preserved.
      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [makeIsoNode('A')],
        edges: [],
        anchorCwd: '/repo',
      });

      // DAG succeeds despite the teardown rejection.
      expect(result.failed).toHaveLength(0);
      expect(result.outputs['A']).toBe('ok');

      // Teardown was indeed called (once), and its rejection was swallowed.
      expect(teardownBackgroundWorktree).toHaveBeenCalledTimes(1);
    });
  });
});
