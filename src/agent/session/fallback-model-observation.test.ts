/**
 * Tests for the provider-event observation seam that wires `model-fallback`
 * notices into `applyFallbackModel` (agent-session.ts, observeProviderEvent).
 *
 * Contract:
 *   - A `notice` with `kind === 'model-fallback'` and `fallback.to` triggers
 *     `applyFallbackModel`, updating session metadata and writing a journal mark.
 *   - Other notice kinds do nothing to the model metadata.
 *   - Plan-text observation still fires for every event (existing behaviour).
 *   - The operation is idempotent: a second identical notice does not write a
 *     second journal mark or mutate metadata again.
 *
 * These tests exercise `applyFallbackModel` directly with mocked deps (the same
 * pattern used in session-config.test.ts) rather than constructing a full
 * AgentSession, so they remain fast and free of SDK/provider I/O.
 *
 * @module agent/session/fallback-model-observation.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));
vi.mock('../awareness/presence.js', () => ({ updatePresenceCwd: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./model-resolution.js', () => ({
  resolveModelId: vi.fn((model: string | undefined) => model),
}));

import { applyFallbackModel, type ConfigDeps } from './session-config.js';
import { SessionStateManager } from './session-state.js';
import { PlanExitBridge } from './plan-exit-bridge.js';
import { resolveModelId } from './model-resolution.js';
import type { AgentConfig } from '../types.js';
import type { JournalLifecycle } from './journal-lifecycle.js';
import type { ProviderQuery } from '../provider.js';
import type { ProviderEvent } from '../provider.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors session-config.test.ts pattern)
// ---------------------------------------------------------------------------

function makeBaseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'sonnet', apiKey: 'test-key', sessionId: 'sess-obs', ...overrides };
}

function makeStateManager(config: AgentConfig = makeBaseConfig()): SessionStateManager {
  return new SessionStateManager(
    { persistSession: false },
    {
      model: config.model as string,
      permissionMode: config.permissionMode ?? 'bypassPermissions',
      sessionId: config.sessionId,
    },
  );
}

function makeProviderQuery(): ProviderQuery {
  return {
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setSystemPrompt: vi.fn().mockReturnValue(true),
    setCwd: vi.fn(),
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
  } as unknown as ProviderQuery;
}

function makeDeps(markModelSwitch: ReturnType<typeof vi.fn>): {
  deps: ConfigDeps;
  stateManager: SessionStateManager;
  providerQuery: ProviderQuery;
} {
  const config = makeBaseConfig();
  const stateManager = makeStateManager(config);
  const providerQuery = makeProviderQuery();
  const journal = { markModelSwitch } as unknown as JournalLifecycle;
  const deps: ConfigDeps = {
    getConfig: () => config,
    setConfig: vi.fn(),
    getProviderQuery: () => providerQuery,
    getStateManager: () => stateManager,
    getPlanExit: () => new PlanExitBridge(),
    pushSidebandEvent: vi.fn(),
    getJournal: () => journal,
  };
  return { deps, stateManager, providerQuery };
}

/**
 * Simulates the observeProviderEvent logic wired in agent-session.ts line 295.
 * Kept inline so this test does not import AgentSession (which requires SDK).
 */
function simulateObserve(event: ProviderEvent, deps: ConfigDeps, planObserve: () => void): void {
  planObserve();
  if (
    event.type === 'notice' &&
    event.kind === 'model-fallback' &&
    event.fallback?.to !== undefined
  ) {
    applyFallbackModel(event.fallback.to, deps);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('observeProviderEvent: model-fallback notice observation', () => {
  beforeEach(() => {
    vi.mocked(resolveModelId).mockImplementation((m) => m as string | undefined);
  });

  it('a model-fallback notice updates session metadata to fallback.to', () => {
    const markModelSwitch = vi.fn();
    const { deps, stateManager } = makeDeps(markModelSwitch);
    const event: ProviderEvent = {
      type: 'notice',
      text: 'Switched to haiku (usage-limit)',
      kind: 'model-fallback',
      fallback: { from: 'sonnet', to: 'haiku', reason: 'usage-limit' },
    };
    simulateObserve(event, deps, () => {});
    expect(stateManager.getSessionMetadata().model).toBe('haiku');
  });

  it('a model-fallback notice writes exactly one journal mark', () => {
    const markModelSwitch = vi.fn();
    const { deps } = makeDeps(markModelSwitch);
    const event: ProviderEvent = {
      type: 'notice',
      text: 'Switched',
      kind: 'model-fallback',
      fallback: { from: 'sonnet', to: 'haiku', reason: 'credit-exhausted' },
    };
    simulateObserve(event, deps, () => {});
    expect(markModelSwitch).toHaveBeenCalledTimes(1);
    expect(markModelSwitch).toHaveBeenCalledWith('haiku');
  });

  it('observing the same model-fallback notice twice is idempotent (no second mark)', () => {
    const markModelSwitch = vi.fn();
    const { deps, stateManager } = makeDeps(markModelSwitch);
    const event: ProviderEvent = {
      type: 'notice',
      text: 'Switched',
      kind: 'model-fallback',
      fallback: { from: 'sonnet', to: 'haiku', reason: 'usage-limit' },
    };
    simulateObserve(event, deps, () => {});
    simulateObserve(event, deps, () => {});
    expect(markModelSwitch).toHaveBeenCalledTimes(1);
    expect(stateManager.getSessionMetadata().model).toBe('haiku');
  });

  it('a non-model-fallback notice kind does not change model metadata', () => {
    const markModelSwitch = vi.fn();
    const { deps, stateManager } = makeDeps(markModelSwitch);
    const before = stateManager.getSessionMetadata().model;
    const event: ProviderEvent = {
      type: 'notice',
      text: 'truncated',
      kind: 'truncation',
    };
    simulateObserve(event, deps, () => {});
    expect(stateManager.getSessionMetadata().model).toBe(before);
    expect(markModelSwitch).not.toHaveBeenCalled();
  });

  it('plan-text observation fires for every event regardless of kind', () => {
    const markModelSwitch = vi.fn();
    const { deps } = makeDeps(markModelSwitch);
    const planObserve = vi.fn();
    const events: ProviderEvent[] = [
      { type: 'notice', text: 'truncated', kind: 'truncation' },
      { type: 'notice', text: 'switched', kind: 'model-fallback', fallback: { from: 'sonnet', to: 'haiku', reason: 'usage-limit' } },
      { type: 'delta.text', text: 'hello' },
    ];
    for (const e of events) simulateObserve(e, deps, planObserve);
    expect(planObserve).toHaveBeenCalledTimes(3);
  });

  it('does NOT call provider setModel when a model-fallback notice is observed', () => {
    const markModelSwitch = vi.fn();
    const { deps, providerQuery } = makeDeps(markModelSwitch);
    const event: ProviderEvent = {
      type: 'notice',
      text: 'Switched',
      kind: 'model-fallback',
      fallback: { from: 'sonnet', to: 'haiku', reason: 'model-rejected' },
    };
    simulateObserve(event, deps, () => {});
    expect(providerQuery.setModel).not.toHaveBeenCalled();
  });
});
