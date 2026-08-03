/**
 * Composed-path regression test for worktree cwd staleness.
 *
 * The unit test in `awareness/runtime-source.test.ts` proves the awareness
 * source re-reads its cwd accessor. This file proves the property that
 * actually reached the model: after a `setCwd()` re-anchor, the REBUILT system
 * prompt's `- Workspace:` line reports the NEW checkout's branch, not the
 * launch directory's.
 *
 * Symptom this guards against: a session started in the main checkout and
 * re-anchored into a worktree (`afk -w`, `/cd`) emitted an `# Environment`
 * block whose `- Working directory:` line pointed at the worktree while its
 * `- Workspace:` line still named the main checkout's branch and HEAD — so the
 * model was told it was on a branch it was not on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCwdDependentsFactory } from './cwd-dependents.js';
import { buildStableSystemPrefix } from './system-prompt.js';
import { buildRuntimeStateSource } from '../../../awareness/index.js';
import { gatherWorkspace } from '../../../awareness/workspace-source.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';
import type { AnthropicToolDef } from '../../../tools/types.js';

// Mock git so the test asserts cwd->branch routing rather than a real repo.
vi.mock('../../../awareness/workspace-source.js', () => ({
  gatherWorkspace: vi.fn(),
}));

const LAUNCH_CWD = '/repo';
const WORKTREE_CWD = '/repo/.afk-worktrees/feature';

/** Branch is derived from cwd so a stale cwd is visible in the output. */
function workspaceFor(cwd: string) {
  return cwd === WORKTREE_CWD
    ? {
        branch: 'afk/feature',
        headSha: 'fea7017',
        dirty: false,
        dirtyCount: 0,
        remoteUrl: null,
      }
    : {
        branch: 'main',
        headSha: 'ma1n000',
        dirty: false,
        dirtyCount: 0,
        remoteUrl: null,
      };
}

function setup() {
  // The provider's live cwd, mutated by setCurrentCwd exactly as
  // AnthropicDirectProvider._currentCwd is.
  let currentCwd: string | undefined = LAUNCH_CWD;

  const runtimeStateSource = buildRuntimeStateSource({
    surface: 'cli',
    getCwd: () => currentCwd ?? LAUNCH_CWD,
    modelName: 'sonnet',
    providerName: 'anthropic-direct',
    permissionMode: 'default',
    getEnabledToolNames: () => [],
    getMcpTools: () => [] as AnthropicToolDef[],
    getSubagents: () => ({ active: [], backgroundJobs: [] }),
  });

  const factory = createCwdDependentsFactory({
    stableSystemPrefix: buildStableSystemPrefix({
      toolBase: 'TOOLBASE',
      memoryPrompt: 'MEMORY',
      hotMemory: '',
      manifest: '',
      userSystem: null,
    }),
    config: { cwd: LAUNCH_CWD } as AgentConfig,
    surface: 'cli',
    runtimeStateSource,
    getCurrentCwd: () => currentCwd,
    setCurrentCwd: (cwd: string) => {
      currentCwd = cwd;
    },
    getCurrentPermissionMode: () => 'default',
    sharedReadRoots: [LAUNCH_CWD],
    sharedWriteRoots: [LAUNCH_CWD],
    subagentExecutor: undefined,
    skillExecutor: undefined,
    composeExecutor: undefined,
    buildDispatcher: () => ({}) as ToolDispatcher,
  });

  return { factory, runtimeStateSource };
}

describe('cwdDependentsFactory — workspace follows the re-anchored cwd', () => {
  beforeEach(() => {
    vi.mocked(gatherWorkspace).mockReset();
    vi.mocked(gatherWorkspace).mockImplementation((cwd: string) => workspaceFor(cwd));
  });

  it('rebuilds the Workspace line for the new worktree, not the launch dir', () => {
    const { factory } = setup();

    const { userSystem } = factory(WORKTREE_CWD);

    expect(userSystem).toContain(`- Working directory: ${WORKTREE_CWD}`);
    // The captured-cwd implementation emitted `main @ ma1n000` here while the
    // working-directory line already pointed at the worktree.
    expect(userSystem).toContain('- Workspace: afk/feature @ fea7017 (clean)');
    expect(userSystem).not.toContain('main @ ma1n000');
  });

  it('gathers git state against the new cwd', () => {
    const { factory } = setup();

    factory(WORKTREE_CWD);

    expect(vi.mocked(gatherWorkspace)).toHaveBeenLastCalledWith(WORKTREE_CWD);
  });

  it('leaves get_runtime_state agreeing with the rebuilt prompt', () => {
    // Invariant: the `self` view's cwd and the `workspace` view's branch must
    // resolve through the same accessor — their disagreement is what made the
    // original bug invisible from inside a session.
    const { factory, runtimeStateSource } = setup();

    factory(WORKTREE_CWD);

    expect(runtimeStateSource.getSelf().cwd).toBe(WORKTREE_CWD);
    expect(runtimeStateSource.getWorkspace().branch).toBe('afk/feature');
  });
});
