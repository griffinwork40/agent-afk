/**
 * Integration tests for the `isolation: "worktree"` wiring in
 * {@link SubagentExecutor.execute}.
 *
 * The reusable worktree primitives (`createIsolatedWorktree` /
 * `teardownIsolatedWorktree`) are unit-tested against a mocked git argv in
 * `handlers/worktree.test.ts`. This suite tests the EXECUTOR'S USE of them —
 * the block in `execute()` (subagent-executor.ts) that, after
 * `buildChildConfig` (which yields `childWriteCapable`) and before dispatch:
 *
 *   1. SKIPS creation for a read-only child (nothing to isolate);
 *   2. else calls `createIsolatedWorktree({ cwd, slugHint })`, sets
 *      `childConfig.cwd = iso.path`, and records
 *      `isolationTeardown = { repoRoot, worktreePath }`;
 *   3. on a `createIsolatedWorktree` throw, FAILS LOUD (isError, no fork) —
 *      never silently falling back to the shared tree;
 *   4. threads `isolationTeardown` into `runForegroundWithPromotion`, whose
 *      finally calls `teardownIsolatedWorktree` (covered in
 *      foreground-promotion's own tests).
 *
 * Seams mocked (so we test executor LOGIC, not git and not a real child run):
 *   - `../handlers/worktree-managed.js` — `createIsolatedWorktree` /
 *     `teardownIsolatedWorktree` as `vi.fn()`. This single mock covers BOTH
 *     importers (subagent-executor.ts AND foreground-promotion.ts resolve the
 *     same absolute module).
 *   - `./foreground-promotion.js` — `runForegroundWithPromotion` as a `vi.fn()`
 *     that captures its args (esp. `isolationTeardown`) and returns a benign
 *     success ToolResult, so no real child is driven. This isolates the
 *     create→cwd→teardown-arg chain at the executor seam.
 *   - `../auth/credential-resolver.js` / `../routing-telemetry.js` — copied
 *     from the sibling `subagent-executor.test.ts` so construction never
 *     touches the keychain / telemetry sink.
 *
 * Construction/mocking of `SubagentExecutorContext`, the manager, and the
 * forked handle mirror `subagent-executor.test.ts` exactly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (must precede the SubagentExecutor import) --------------

// Credential resolver + routing telemetry: decouple construction from the live
// keychain / env, mirroring subagent-executor.test.ts. NOTE the relative depth:
// this test sits one level deeper (subagent/) than subagent-executor.test.ts
// (tools/), so the module specifiers gain one extra `../`.
const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'resolved-test-credential' as string | undefined),
);
vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision }));

// Worktree primitives: the two functions the isolation block + the foreground
// finally call. Shared by both importers (same absolute module).
const createIsolatedWorktree = vi.hoisted(() => vi.fn());
const teardownIsolatedWorktree = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ removed: true, preserved: false }),
);
vi.mock('../handlers/worktree-managed.js', () => ({
  createIsolatedWorktree,
  teardownIsolatedWorktree,
}));

// Foreground path: capture the args (isolationTeardown, childManager) without
// running a real child. Returns a benign success ToolResult. When a test needs
// the REAL foreground finally (teardown wiring), it un-mocks per-test via
// vi.mocked(...).mockImplementation reaching the real module — but for the
// executor-seam assertions the double suffices.
const runForegroundWithPromotion = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ content: 'foreground-double-result' }),
);
vi.mock('./foreground-promotion.js', () => ({
  runForegroundWithPromotion,
}));

import type { SubagentHandle, SubagentResult } from '../../subagent.js';
import type { IAgentSession } from '../../types.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ToolCall } from '../types.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../subagent-executor.js';

// --- Shared harness (mirrors subagent-executor.test.ts) --------------------

function mockHandle(overrides?: Partial<{ status: string }>): Partial<SubagentHandle> {
  return {
    id: 'test-handle',
    status: (overrides?.status ?? 'succeeded') as SubagentHandle['status'],
    runToResult: vi.fn().mockResolvedValue({
      id: 'test-handle',
      status: overrides?.status ?? 'succeeded',
      message: { role: 'assistant', content: 'test output', timestamp: new Date() },
    } as SubagentResult),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
  };
}

function makeCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: 'test-call',
    name: 'agent',
    input: { prompt: 'do something' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** The shape createIsolatedWorktree resolves with (ManagedWorktreeInfo & { repoRoot }). */
const ISO_RESULT = {
  path: '/repo/.afk-worktrees/iso-agent-tool-1-abc123',
  branch: 'afk/iso-agent-tool-1-abc123',
  baseRef: 'HEAD',
  baseSha: 'deadbeef',
  repoRoot: '/repo',
};

describe('SubagentExecutor — isolation:"worktree" wiring', () => {
  let mockSubagentMgr: { forkSubagent: ReturnType<typeof vi.fn> };
  let mockParentSession: Partial<IAgentSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore benign defaults cleared above.
    mockResolveCredentialForModel.mockReturnValue('resolved-test-credential');
    teardownIsolatedWorktree.mockResolvedValue({ removed: true, preserved: false });
    runForegroundWithPromotion.mockResolvedValue({ content: 'foreground-double-result' });

    mockSubagentMgr = { forkSubagent: vi.fn().mockResolvedValue(mockHandle()) };
    mockParentSession = {
      sessionId: 'parent-session-id',
      getInputStreamRef: vi.fn(),
      abortSignal: new AbortController().signal,
    };
  });

  /** Build an executor. `allowedTools` (a read-only cage) drives childWriteCapable=false. */
  function makeExecutor(overrides?: Partial<SubagentExecutorContext>): SubagentExecutor {
    const ctx: SubagentExecutorContext = {
      subagentManager: mockSubagentMgr as never,
      parentSession: mockParentSession as never,
      defaultConfig: { apiKey: 'test-key', systemPrompt: 'test system prompt' },
      depth: 0,
      // A real cwd so the anchor is deterministic (executor uses
      // `this.currentCwd ?? process.cwd()` as createIsolatedWorktree's cwd).
      cwd: '/repo',
      ...overrides,
    };
    return new SubagentExecutor(ctx);
  }

  // ------------------------------------------------------------------------
  // (1) write-capable + isolation:'worktree' → create once, cwd rewritten,
  //     isolationTeardown threaded into the foreground call.
  // ------------------------------------------------------------------------
  describe('write-capable dispatch', () => {
    it('creates the worktree once, rewrites child cwd, and threads isolationTeardown', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      // Unrestricted cage (allowedTools unset) ⇒ childWriteCapable=true.
      const executor = makeExecutor();

      const result = await executor.execute(
        makeCall({ input: { prompt: 'build a feature', isolation: 'worktree' } }),
      );

      // Not an error, and the foreground double's result flows out verbatim.
      expect(result.isError).toBeUndefined();

      // createIsolatedWorktree called exactly once, anchored at the session cwd,
      // with a collision-safe slug hint derived from the id_prefix.
      expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);
      const createArg = createIsolatedWorktree.mock.calls[0]![0] as {
        cwd: string;
        slugHint: string;
      };
      expect(createArg.cwd).toBe('/repo');
      expect(createArg.slugHint).toMatch(/^iso-agent-tool-\d+-[a-z0-9]+$/);

      // The child config handed to forkSubagent carries cwd = the worktree path
      // (the executor mutated childConfig.cwd = iso.path before dispatch).
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
      const forkArg = mockSubagentMgr.forkSubagent.mock.calls[0]![0] as {
        config: AgentConfig;
      };
      expect(forkArg.config.cwd).toBe(ISO_RESULT.path);

      // isolationTeardown was threaded into the foreground path as
      // { repoRoot, worktreePath } sourced from the create result.
      expect(runForegroundWithPromotion).toHaveBeenCalledTimes(1);
      const fgArg = runForegroundWithPromotion.mock.calls[0]![0] as {
        isolationTeardown?: { repoRoot: string; worktreePath: string };
      };
      expect(fgArg.isolationTeardown).toEqual({
        repoRoot: ISO_RESULT.repoRoot,
        worktreePath: ISO_RESULT.path,
      });
    });

    it('gives concurrent dispatches distinct slug hints (monotonic counter)', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const executor = makeExecutor();

      await executor.execute(makeCall({ input: { prompt: 'a', isolation: 'worktree' } }));
      await executor.execute(makeCall({ input: { prompt: 'b', isolation: 'worktree' } }));

      const slug0 = (createIsolatedWorktree.mock.calls[0]![0] as { slugHint: string }).slugHint;
      const slug1 = (createIsolatedWorktree.mock.calls[1]![0] as { slugHint: string }).slugHint;
      expect(slug0).not.toBe(slug1);
    });
  });

  // ------------------------------------------------------------------------
  // (2) read-only dispatch + isolation:'worktree' → SKIP creation, no error,
  //     child dispatched normally (cwd untouched, no isolationTeardown).
  // ------------------------------------------------------------------------
  describe('read-only dispatch (skip path)', () => {
    it('does NOT create a worktree; dispatches normally with no isolationTeardown', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      // A read-only cage (no write/edit, no mutating bash) ⇒ childWriteCapable=false.
      // Same mechanism as child-config.test.ts "is false for a read-only cage".
      const executor = makeExecutor({ allowedTools: ['read_file', 'grep', 'glob'] });

      const result = await executor.execute(
        makeCall({ input: { prompt: 'inspect the repo', isolation: 'worktree' } }),
      );

      // Skip path: creation never runs, and the call is not an error.
      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(result.isError).toBeUndefined();

      // The child is still dispatched (fork + foreground), just with no
      // isolated cwd and no teardown record.
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
      const forkArg = mockSubagentMgr.forkSubagent.mock.calls[0]![0] as {
        config: AgentConfig;
      };
      // cwd on the child config is not the worktree path (isolation was skipped).
      expect(forkArg.config.cwd).not.toBe(ISO_RESULT.path);

      expect(runForegroundWithPromotion).toHaveBeenCalledTimes(1);
      const fgArg = runForegroundWithPromotion.mock.calls[0]![0] as {
        isolationTeardown?: unknown;
      };
      expect(fgArg.isolationTeardown).toBeUndefined();
    });

    it('read-only cage with read-only bash also skips (bash present but non-mutating)', async () => {
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      // Mirrors child-config.test.ts "is false when bash is allowed but read-only".
      const executor = makeExecutor({
        allowedTools: ['read_file', 'grep', 'bash'],
        readOnlyBash: true,
      });

      const result = await executor.execute(
        makeCall({ input: { prompt: 'inspect', isolation: 'worktree' } }),
      );

      expect(createIsolatedWorktree).not.toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------------------
  // (3) createIsolatedWorktree throws → FAIL LOUD: isError, no fork, no
  //     foreground run. Never silently falls back to the shared tree.
  // ------------------------------------------------------------------------
  describe('createIsolatedWorktree throws (non-git cwd)', () => {
    it('resolves to an isError result mentioning "isolated worktree" and never forks', async () => {
      createIsolatedWorktree.mockRejectedValue(new Error('Not in a git repository.'));
      const executor = makeExecutor();

      const result = await executor.execute(
        makeCall({ input: { prompt: 'build a feature', isolation: 'worktree' } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('isolated worktree');
      // Fail loud: the underlying error is surfaced.
      expect(result.content).toContain('Not in a git repository.');

      // No fork happened → no foreground/background dispatch either.
      expect(mockSubagentMgr.forkSubagent).not.toHaveBeenCalled();
      expect(runForegroundWithPromotion).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------------
  // (4) teardown plumbing — the value threaded as isolationTeardown equals
  //     { repoRoot, worktreePath } derived from the create result. Asserted at
  //     the foreground seam (runForegroundWithPromotion), which is the arg the
  //     real foreground finally forwards to teardownIsolatedWorktree.
  // ------------------------------------------------------------------------
  describe('teardown plumbing', () => {
    it('threads exactly { repoRoot, worktreePath } from the create result', async () => {
      createIsolatedWorktree.mockResolvedValue({
        ...ISO_RESULT,
        path: '/repo/.afk-worktrees/iso-xyz',
        repoRoot: '/repo',
      });
      const executor = makeExecutor();

      await executor.execute(
        makeCall({ input: { prompt: 'work', isolation: 'worktree' } }),
      );

      const fgArg = runForegroundWithPromotion.mock.calls[0]![0] as {
        isolationTeardown?: { repoRoot: string; worktreePath: string };
      };
      expect(fgArg.isolationTeardown).toEqual({
        repoRoot: '/repo',
        worktreePath: '/repo/.afk-worktrees/iso-xyz',
      });
      // worktreePath comes from `iso.path`, NOT from any caller-supplied cwd —
      // pin that the two are wired from the same create result.
      const forkArg = mockSubagentMgr.forkSubagent.mock.calls[0]![0] as {
        config: AgentConfig;
      };
      expect(forkArg.config.cwd).toBe(fgArg.isolationTeardown!.worktreePath);
    });

    it('end-to-end teardown: the real foreground finally calls teardownIsolatedWorktree with the threaded record', async () => {
      // Un-mock the foreground path for THIS test so the real finally runs and
      // forwards isolationTeardown → teardownIsolatedWorktree (still mocked).
      const real = await vi.importActual<typeof import('./foreground-promotion.js')>(
        './foreground-promotion.js',
      );
      runForegroundWithPromotion.mockImplementation(real.runForegroundWithPromotion);
      createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
      const executor = makeExecutor();

      const result = await executor.execute(
        makeCall({ input: { prompt: 'build', isolation: 'worktree' } }),
      );

      // Real foreground drove the mock handle to success.
      expect(result.isError).toBeUndefined();
      // The finally forwarded the threaded record to the (mocked) teardown.
      expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1);
      const tdArg = teardownIsolatedWorktree.mock.calls[0]![0] as {
        repoRoot: string;
        worktreePath: string;
      };
      expect(tdArg.repoRoot).toBe(ISO_RESULT.repoRoot);
      expect(tdArg.worktreePath).toBe(ISO_RESULT.path);
    });
  });
});
