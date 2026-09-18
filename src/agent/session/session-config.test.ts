/**
 * Unit tests for the config-mutation functions in `session-config.ts`.
 *
 * Each function receives its dependencies explicitly through the
 * {@link ConfigDeps} interface, so tests wire up a `makeMockDeps()` helper
 * that returns a fully-stubbed ConfigDeps and assert only the contractual
 * side-effects without spinning up a real AgentSession.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be registered BEFORE the module under test is imported.
vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));
vi.mock('../awareness/presence.js', () => ({ updatePresenceCwd: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./model-resolution.js', () => ({
  resolveModelId: vi.fn((model: string | undefined) => model),
}));

import {
  setModel,
  setPermissionMode,
  setSystemPrompt,
  setCwd,
  reauth,
  takePendingPlanExitSeed,
  type ConfigDeps,
} from './session-config.js';
import { PlanExitBridge } from './plan-exit-bridge.js';
import { SessionStateManager } from './session-state.js';
import { updatePresenceCwd } from '../awareness/presence.js';
import { resolveModelId } from './model-resolution.js';
import type { AgentConfig } from '../types.js';
import type { ProviderQuery } from '../provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'sonnet', apiKey: 'test-key', sessionId: 'sess-1', ...overrides };
}

function makeStateManager(config: AgentConfig = makeBaseConfig()): SessionStateManager {
  return new SessionStateManager(
    { surface: 'cli' },
    {
      model: config.model as string,
      permissionMode: config.permissionMode ?? 'bypassPermissions',
      sessionId: config.sessionId,
    },
  );
}

function makeProviderQuery(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return {
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setSystemPrompt: vi.fn().mockReturnValue(true),
    setCwd: vi.fn(),
    reauth: vi.fn().mockResolvedValue({ accountId: 'acct-1', swapped: false }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({}),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
    rewindFiles: vi.fn().mockResolvedValue({ canRewind: false }),
    close: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
    ...overrides,
  } as unknown as ProviderQuery;
}

function makeMockDeps(overrides: {
  config?: Partial<AgentConfig>;
  providerQuery?: Partial<ProviderQuery>;
} = {}): {
  deps: ConfigDeps;
  config: AgentConfig;
  stateManager: SessionStateManager;
  providerQuery: ProviderQuery;
  planExit: PlanExitBridge;
  pushSidebandEvent: ReturnType<typeof vi.fn>;
} {
  const config = makeBaseConfig(overrides.config);
  const stateManager = makeStateManager(config);
  const providerQuery = makeProviderQuery(overrides.providerQuery);
  const planExit = new PlanExitBridge();
  const pushSidebandEvent = vi.fn();

  const deps: ConfigDeps = {
    getConfig: () => config,
    setConfig: vi.fn((patch) => {
      const updated = patch(config);
      Object.assign(config, updated);
    }),
    getProviderQuery: () => providerQuery,
    getStateManager: () => stateManager,
    getPlanExit: () => planExit,
    pushSidebandEvent,
  };

  return { deps, config, stateManager, providerQuery, planExit, pushSidebandEvent };
}

// ---------------------------------------------------------------------------
// setModel
// ---------------------------------------------------------------------------

describe('setModel', () => {
  beforeEach(() => {
    vi.mocked(resolveModelId).mockImplementation((m) => m as string | undefined);
  });

  it('calls provider setModel with the alias string', async () => {
    const { deps, providerQuery } = makeMockDeps();
    await setModel('haiku', deps);
    expect(providerQuery.setModel).toHaveBeenCalledWith('haiku');
  });

  it('updates session metadata with the resolved id', async () => {
    vi.mocked(resolveModelId).mockReturnValue('claude-haiku-4-5');
    const { deps, stateManager } = makeMockDeps();
    await setModel('haiku', deps);
    expect(stateManager.getSessionMetadata().model).toBe('claude-haiku-4-5');
  });

  it('does not call provider setModel when model is undefined', async () => {
    const { deps, providerQuery } = makeMockDeps();
    await setModel(undefined, deps);
    expect(providerQuery.setModel).not.toHaveBeenCalled();
  });

  it('does not call provider setModel when model is an empty string', async () => {
    const { deps, providerQuery } = makeMockDeps();
    await setModel('', deps);
    expect(providerQuery.setModel).not.toHaveBeenCalled();
  });

  it('does not update metadata when resolveModelId returns undefined', async () => {
    vi.mocked(resolveModelId).mockReturnValue(undefined);
    const { deps, stateManager } = makeMockDeps();
    const before = stateManager.getSessionMetadata().model;
    await setModel('ghost', deps);
    expect(stateManager.getSessionMetadata().model).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// setPermissionMode
// ---------------------------------------------------------------------------

describe('setPermissionMode', () => {
  it('records the mode transition on the PlanExitBridge', async () => {
    const { deps, planExit } = makeMockDeps();
    const spy = vi.spyOn(planExit, 'recordModeTransition');
    await setPermissionMode('plan', deps);
    expect(spy).toHaveBeenCalledWith('plan', 'bypassPermissions');
  });

  it('updates the session metadata permissionMode', async () => {
    const { deps, stateManager } = makeMockDeps();
    await setPermissionMode('plan', deps);
    expect(stateManager.getSessionMetadata().permissionMode).toBe('plan');
  });

  it('calls provider setPermissionMode', async () => {
    const { deps, providerQuery } = makeMockDeps();
    await setPermissionMode('default', deps);
    expect(providerQuery.setPermissionMode).toHaveBeenCalledWith('default');
  });

  it('pushes a plan_mode sideband event with mode "plan" when entering plan', async () => {
    const { deps, pushSidebandEvent } = makeMockDeps();
    await setPermissionMode('plan', deps);
    expect(pushSidebandEvent).toHaveBeenCalledWith({ type: 'plan_mode', mode: 'plan' });
  });

  it('pushes a plan_mode sideband event with mode "default" when leaving plan', async () => {
    const { deps, pushSidebandEvent } = makeMockDeps();
    await setPermissionMode('default', deps);
    expect(pushSidebandEvent).toHaveBeenCalledWith({ type: 'plan_mode', mode: 'default' });
  });

  it('pushes mode "default" for any non-plan permission mode', async () => {
    const { deps, pushSidebandEvent } = makeMockDeps();
    await setPermissionMode('bypassPermissions', deps);
    expect(pushSidebandEvent).toHaveBeenCalledWith({ type: 'plan_mode', mode: 'default' });
  });
});

// ---------------------------------------------------------------------------
// setSystemPrompt
// ---------------------------------------------------------------------------

describe('setSystemPrompt', () => {
  it('returns true when the provider supports setSystemPrompt', () => {
    const { deps } = makeMockDeps({ providerQuery: { setSystemPrompt: vi.fn().mockReturnValue(true) } });
    expect(setSystemPrompt('new prompt', deps)).toBe(true);
  });

  it('returns false when the provider returns false', () => {
    const { deps } = makeMockDeps({ providerQuery: { setSystemPrompt: vi.fn().mockReturnValue(false) } });
    expect(setSystemPrompt('new prompt', deps)).toBe(false);
  });

  it('returns false when setSystemPrompt is absent on the provider', () => {
    const { deps } = makeMockDeps({ providerQuery: { setSystemPrompt: undefined } });
    expect(setSystemPrompt('new prompt', deps)).toBe(false);
  });

  it('updates config.systemPrompt via setConfig', () => {
    const { deps, config } = makeMockDeps();
    setSystemPrompt('injected', deps);
    expect(config.systemPrompt).toBe('injected');
  });

  it('accepts undefined to clear the system prompt', () => {
    const { deps, config } = makeMockDeps();
    setSystemPrompt(undefined, deps);
    expect(config.systemPrompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setCwd
// ---------------------------------------------------------------------------

describe('setCwd', () => {
  it('updates config.cwd via setConfig', () => {
    const { deps, config } = makeMockDeps();
    setCwd('/new/dir', deps);
    expect(config.cwd).toBe('/new/dir');
  });

  it('calls provider setCwd when present', () => {
    const { deps, providerQuery } = makeMockDeps();
    setCwd('/new/dir', deps);
    expect(providerQuery.setCwd).toHaveBeenCalledWith('/new/dir');
  });

  it('calls updatePresenceCwd with sessionId and new cwd', () => {
    const { deps } = makeMockDeps({ config: { sessionId: 'sess-abc' } });
    setCwd('/my/worktree', deps);
    expect(updatePresenceCwd).toHaveBeenCalledWith('sess-abc', '/my/worktree');
  });

  it('skips updatePresenceCwd when sessionId is undefined', () => {
    const { deps } = makeMockDeps({ config: { sessionId: undefined } });
    vi.mocked(updatePresenceCwd).mockClear();
    setCwd('/my/worktree', deps);
    expect(updatePresenceCwd).not.toHaveBeenCalled();
  });

  it('does not throw when provider setCwd is absent', () => {
    const { deps } = makeMockDeps({ providerQuery: { setCwd: undefined } });
    expect(() => setCwd('/new/dir', deps)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// reauth
// ---------------------------------------------------------------------------

describe('reauth', () => {
  it('returns the provider reauth result when supported', async () => {
    const { deps } = makeMockDeps({
      providerQuery: {
        reauth: vi.fn().mockResolvedValue({ accountId: 'acct-42', swapped: true }),
      },
    });
    const result = await reauth(deps);
    expect(result).toEqual({ accountId: 'acct-42', swapped: true });
  });

  it('returns null when provider reauth is absent', async () => {
    const { deps } = makeMockDeps({ providerQuery: { reauth: undefined } });
    expect(await reauth(deps)).toBeNull();
  });

  it('returns null when provider reauth returns null', async () => {
    const { deps } = makeMockDeps({ providerQuery: { reauth: vi.fn().mockResolvedValue(null) } });
    expect(await reauth(deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// takePendingPlanExitSeed
// ---------------------------------------------------------------------------

describe('takePendingPlanExitSeed', () => {
  it('returns undefined when no seed is pending', async () => {
    const { deps } = makeMockDeps();
    expect(await takePendingPlanExitSeed(deps)).toBeUndefined();
  });

  it('returns the seed message and mode when a seed is pending', async () => {
    const { deps, planExit, pushSidebandEvent } = makeMockDeps();
    planExit.requestImplementSeed('implement this', 'default');
    const result = await takePendingPlanExitSeed(deps);
    expect(result).toEqual({ message: 'implement this', mode: 'default' });
    expect(pushSidebandEvent).toHaveBeenCalledWith({ type: 'plan_mode', mode: 'default' });
  });

  it('atomically drains the seed — a second call returns undefined', async () => {
    const { deps, planExit } = makeMockDeps();
    planExit.requestImplementSeed('do it', 'default');
    await takePendingPlanExitSeed(deps);
    expect(await takePendingPlanExitSeed(deps)).toBeUndefined();
  });

  it('applies the deferred permission-mode flip (updates metadata)', async () => {
    const { deps, stateManager, planExit, pushSidebandEvent } = makeMockDeps();
    planExit.requestImplementSeed('go', 'default');
    await takePendingPlanExitSeed(deps);
    expect(stateManager.getSessionMetadata().permissionMode).toBe('default');
    expect(pushSidebandEvent).toHaveBeenCalledWith({ type: 'plan_mode', mode: 'default' });
  });

  it('returns undefined and drops the seed when the permission-mode flip rejects', async () => {
    const { deps, planExit } = makeMockDeps({
      providerQuery: {
        setPermissionMode: vi.fn().mockRejectedValue(new Error('provider refused')),
      },
    });
    planExit.requestImplementSeed('go', 'default');
    const result = await takePendingPlanExitSeed(deps);
    expect(result).toBeUndefined();
    // Seed must have been consumed — no second attempt possible.
    expect(await takePendingPlanExitSeed(deps)).toBeUndefined();
  });
});
