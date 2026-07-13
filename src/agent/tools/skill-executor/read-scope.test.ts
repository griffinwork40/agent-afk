/**
 * Regression tests (#547): the `skill` tool's forked-dispatch paths seed each
 * per-call SubagentManager's `parentReadRoots` from the parent session's read
 * scope, so a skill-forked child's read scope ⊇ the parent session's — the same
 * invariant #544 established for the `agent` tool (subagent-worktree-readroot.test.ts).
 *
 * Before this fix, `executeForkedRegistrySkill` / `executePluginSkill` built
 * their managers with `cwd` only, so a fork under an UNCONFINED (read-open)
 * parent operating in a worktree was silently re-confined to [worktree, mainRoot]
 * — narrower than the parent, the residual gap of #544.
 *
 * The test exercises the REAL fork-dispatch code (not the manager in isolation):
 * it spies `SubagentManager.prototype.forkSubagent` and, inside the spy, reads
 * back `this.getReadScopeInputs()` — which returns the `parentReadRoots` the
 * REAL constructor received from fork-dispatch. Writes stay confined (a separate
 * axis, unchanged here).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Keep the credential resolver off the live keychain/env.
vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'resolved-test-credential' as string | undefined),
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import { SkillExecutor } from '../skill-executor.js';
import { registerSkill, _resetRegistry } from '../../../skills/index.js';
import { SubagentManager } from '../../subagent.js';
import type { ReadScopeInputs } from '../../subagent-read-scope.js';
import * as promptLoader from '../../../skills/_lib/prompt-loader.js';

const abortSignal = new AbortController().signal;
const FS_ROOT = path.parse(path.resolve('.')).root || path.sep;
const WORKTREE = '/repo/.afk-worktrees/wt';

function makeCall(input: unknown) {
  return { id: 'test-call', name: 'skill', input, signal: abortSignal };
}

/**
 * Register a `context: fork` registry skill, stub its prompts, and spy
 * forkSubagent so it (a) captures the manager's read-scope inputs and (b)
 * returns a minimal succeeding handle. Returns a getter for the captured scope.
 */
function armForkCapture(): { getCaptured: () => ReadScopeInputs | undefined } {
  let captured: ReadScopeInputs | undefined;
  registerSkill({
    name: 'fork-skill',
    description: 'test',
    context: 'fork',
    handler: vi.fn(),
  });
  vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
    'system.md': 'fake-system-prompt',
  });
  vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
    async function (this: SubagentManager) {
      // The real constructor already ran with fork-dispatch's options, so this
      // reflects the parentReadRoots/​parentCwd that were actually passed.
      captured = this.getReadScopeInputs();
      return {
        id: 'child',
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'ok' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<SubagentManager['forkSubagent']>>;
    },
  );
  vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
  return { getCaptured: () => captured };
}

function makeExecutor(opts: {
  cwd?: string;
  getReadScopeInputs?: () => ReadScopeInputs;
}): SkillExecutor {
  return new SkillExecutor({
    parentSession: {
      sessionId: 'parent-123',
      getInputStreamRef: () => ({ pushUserMessage: () => {} }),
      abortSignal,
    },
    defaultModel: 'sonnet',
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.getReadScopeInputs !== undefined
      ? { getReadScopeInputs: opts.getReadScopeInputs }
      : {}),
  });
}

describe('skill fork read-scope inheritance (#547)', () => {
  beforeEach(() => {
    _resetRegistry();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grants read-open to a worktree skill fork under an UNCONFINED parent session', async () => {
    const { getCaptured } = armForkCapture();
    const executor = makeExecutor({
      cwd: WORKTREE,
      getReadScopeInputs: () => ({ parentReadRoots: undefined, parentCwd: undefined }),
    });

    const result = await executor.execute(makeCall({ name: 'fork-skill' }));
    expect(result.isError).toBeUndefined();

    // THE fix: read-open (filesystem root), not re-confined to [worktree, mainRoot].
    expect(getCaptured()?.parentReadRoots).toEqual([FS_ROOT]);
  });

  it('unions the worktree with a CONFINED parent session cwd (child ⊇ parent)', async () => {
    const { getCaptured } = armForkCapture();
    const executor = makeExecutor({
      cwd: WORKTREE,
      getReadScopeInputs: () => ({ parentReadRoots: undefined, parentCwd: '/repo' }),
    });

    await executor.execute(makeCall({ name: 'fork-skill' }));

    expect(getCaptured()?.parentReadRoots).toEqual([WORKTREE, '/repo']);
  });

  it('propagates an explicit /allow-dir-widened parent read scope to the fork', async () => {
    const { getCaptured } = armForkCapture();
    const executor = makeExecutor({
      cwd: WORKTREE,
      getReadScopeInputs: () => ({
        parentReadRoots: ['/repo', '/tmp/shared'],
        parentCwd: '/repo',
      }),
    });

    await executor.execute(makeCall({ name: 'fork-skill' }));

    expect(getCaptured()?.parentReadRoots).toEqual([WORKTREE, '/repo', '/tmp/shared']);
  });

  it('leaves cwd-derivation untouched when getReadScopeInputs is unwired (back-compat)', async () => {
    const { getCaptured } = armForkCapture();
    // No getReadScopeInputs → parentReadRoots must NOT be set; the manager's own
    // cwd-derivation (its parentCwd = WORKTREE) then produces [worktree, mainRoot].
    const executor = makeExecutor({ cwd: WORKTREE });

    await executor.execute(makeCall({ name: 'fork-skill' }));

    const captured = getCaptured();
    expect(captured?.parentReadRoots).toBeUndefined();
    // cwd still flows through as the manager's parentCwd (worktree isolation).
    expect(captured?.parentCwd).toBe(WORKTREE);
  });
});
