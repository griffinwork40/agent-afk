/**
 * Regression test for effect-ledger sessionId loss after `afk -w` cwd switch.
 *
 * Root cause: `createCwdDependentsFactory` previously read `args.config.sessionId`
 * (a resume-only field, absent on fresh sessions) when rebuilding both the system
 * prompt and the dispatcher after a mid-session setCwd(). The minted id was
 * available in `dispatcher-wiring.ts` but was never threaded into the factory,
 * so every PreToolUse hook context after the switch carried `sessionId: undefined`,
 * causing effect-ledger records to be written with no sessionId.
 *
 * Fix: `CwdDependentsFactoryArgs` now accepts an explicit `resolvedSessionId`
 * field (the minted-or-resumed id from `resolveTopLevelSessionId`) which is
 * used at both sites instead of `config.sessionId`.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCwdDependentsFactory, type CwdDependentsFactoryArgs } from './cwd-dependents.js';
import { buildStableSystemPrefix } from './system-prompt.js';
import { buildRuntimeStateSource } from '../../../awareness/index.js';
import { gatherWorkspace } from '../../../awareness/workspace-source.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';
import type { AnthropicToolDef } from '../../../tools/types.js';

vi.mock('../../../awareness/workspace-source.js', () => ({
  gatherWorkspace: vi.fn(() => ({
    branch: 'afk/wt',
    headSha: 'abc1234',
    dirty: false,
    dirtyCount: 0,
    remoteUrl: null,
  })),
}));

const LAUNCH_CWD = '/repo';
const WORKTREE_CWD = '/repo/.afk-worktrees/feature';
const MINTED_ID = 'a1b2c3d4-minted-session-id';

type BuildDispatcher = CwdDependentsFactoryArgs['buildDispatcher'];

function makeFactory(
  configOverrides: Partial<AgentConfig>,
  resolvedSessionId: string | undefined,
  buildDispatcher: BuildDispatcher,
) {
  let currentCwd: string | undefined = LAUNCH_CWD;
  const runtimeStateSource = buildRuntimeStateSource({
    surface: 'cli',
    getCwd: () => currentCwd ?? LAUNCH_CWD,
    modelName: 'sonnet',
    providerName: 'anthropic-direct',
    permissionMode: 'default',
    getEnabledToolNames: () => [],
    getMcpTools: () => [] as AnthropicToolDef[],
    getMcpServerStates: () => [],
    getSubagents: () => ({ active: [], backgroundJobs: [] }),
  });

  return createCwdDependentsFactory({
    stableSystemPrefix: buildStableSystemPrefix({
      toolBase: 'TOOLBASE',
      memoryPrompt: '',
      workspacePrompt: '',
      hotMemory: '',
      manifest: '',
      userSystem: null,
    }),
    config: { cwd: LAUNCH_CWD, ...configOverrides } as AgentConfig,
    resolvedSessionId,
    surface: 'cli',
    runtimeStateSource,
    getCurrentCwd: () => currentCwd,
    setCurrentCwd: (cwd) => { currentCwd = cwd; },
    getCurrentPermissionMode: () => 'default',
    sharedReadRoots: [LAUNCH_CWD],
    sharedWriteRoots: [LAUNCH_CWD],
    subagentExecutor: undefined,
    skillExecutor: undefined,
    composeExecutor: undefined,
    buildDispatcher,
  });
}

describe('cwd-dependents sessionId fix — resolvedSessionId threads through after cwd switch', () => {
  it('REGRESSION: passes resolvedSessionId (not config.sessionId) to rebuilt dispatcher', () => {
    const buildDispatcher = vi.fn<BuildDispatcher>(() => ({}) as ToolDispatcher);
    // Fresh session: config.sessionId is absent (resume-only), but resolvedSessionId
    // carries the minted id from resolveTopLevelSessionId.
    const factory = makeFactory({ sessionId: undefined }, MINTED_ID, buildDispatcher);

    factory(WORKTREE_CWD);

    expect(buildDispatcher).toHaveBeenCalledOnce();
    expect(buildDispatcher).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ sessionId: MINTED_ID }),
    );
  });

  it('system prompt carries resolvedSessionId after the cwd switch', () => {
    const buildDispatcher = vi.fn<BuildDispatcher>(() => ({}) as ToolDispatcher);
    const factory = makeFactory({ sessionId: undefined }, MINTED_ID, buildDispatcher);

    const { userSystem } = factory(WORKTREE_CWD);

    // The assembled prompt includes `- Session: <first-8-chars> (cli)` — the
    // prefix is the first 8 hex chars of the resolved id.
    expect(userSystem).toContain('- Session: a1b2c3d4 (cli)');
  });

  it('does not regress when config.sessionId is set (resume path)', () => {
    // On --resume, config.sessionId and resolvedSessionId both carry the same id.
    const buildDispatcher = vi.fn<BuildDispatcher>(() => ({}) as ToolDispatcher);
    const factory = makeFactory({ sessionId: MINTED_ID }, MINTED_ID, buildDispatcher);

    factory(WORKTREE_CWD);

    expect(buildDispatcher).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ sessionId: MINTED_ID }),
    );
  });

  it('dispatcher sessionId is undefined when resolvedSessionId is undefined (depth>0 subagent)', () => {
    // Child sessions may genuinely have no resolved id; the fix must not
    // fabricate one — it should propagate undefined faithfully.
    const buildDispatcher = vi.fn<BuildDispatcher>(() => ({}) as ToolDispatcher);
    const factory = makeFactory({ sessionId: undefined }, undefined, buildDispatcher);

    factory(WORKTREE_CWD);

    const opts = buildDispatcher.mock.calls[0]![1];
    expect(opts.sessionId).toBeUndefined();
  });
});
