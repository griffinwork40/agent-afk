/**
 * Tests for the `usageGate` blocked path in `executeOnce` (#4525).
 *
 * PR #4475 introduced a `usageGate` helper (execute-once.ts lines ~68-84) that
 * calls `evaluateDispatchUsageForModel` and, when `blocked: true`, calls
 * `budgetReceipt.rollback()` and returns an `isError: true` refusal.
 *
 * The compose-executor has a parallel blocking path tested in
 * `compose-executor.billing-cutoff.test.ts`.  This file covers the
 * `executeOnce` integration point that was waived as non-blocking in #4475.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from './types.js';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision }));

vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'test-key'),
  loadAnthropicCredential: vi.fn(() => 'test-key'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

// Default: healthy (not blocked).  Individual tests override with mockResolvedValueOnce.
const evaluateDispatchUsageForModel = vi.hoisted(() =>
  vi.fn(async () => ({ notice: undefined as string | undefined, blocked: false })),
);
vi.mock('./usage-notice.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./usage-notice.js')>(),
  evaluateDispatchUsageForModel,
}));

// ─── Imports (after vi.mock declarations) ─────────────────────────────────────

import { SubagentExecutor } from './subagent-executor.js';
import { DelegationBudget } from './delegation-budget.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: 'test-call',
    name: 'agent',
    input: { prompt: 'do something' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeExecutor(budget: DelegationBudget): SubagentExecutor {
  const mockManager = {
    forkSubagent: vi.fn().mockResolvedValue({
      id: 'test-handle',
      status: 'succeeded',
      runToResult: vi.fn().mockResolvedValue({
        id: 'test-handle',
        status: 'succeeded',
        message: { role: 'assistant', content: 'ok', timestamp: new Date() },
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
    }),
  };

  const ctx: SubagentExecutorContext = {
    subagentManager: mockManager as any,
    parentSession: {
      sessionId: 'parent-session-id',
      abortSignal: new AbortController().signal,
    } as any,
    defaultConfig: { apiKey: 'test-key', systemPrompt: 'test system prompt' },
    defaultSubagentModel: 'haiku',
    depth: 0,
    delegationBudget: budget,
  };

  return new SubagentExecutor(ctx);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeOnce usageGate blocked path (#4525)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError: true with "usage limit exceeded" when evaluateDispatchUsageForModel is blocked', async () => {
    evaluateDispatchUsageForModel.mockResolvedValueOnce({
      notice: 'quota exceeded',
      blocked: true,
    });

    const budget = new DelegationBudget({});
    const executor = makeExecutor(budget);

    const result = await executor.execute(makeCall());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('usage limit exceeded');
  });

  it('includes the notice text in the refusal message', async () => {
    evaluateDispatchUsageForModel.mockResolvedValueOnce({
      notice: 'quota exceeded',
      blocked: true,
    });

    const budget = new DelegationBudget({});
    const executor = makeExecutor(budget);

    const result = await executor.execute(makeCall());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('quota exceeded');
  });

  it('calls rollback() on the delegation-budget receipt when blocked', async () => {
    evaluateDispatchUsageForModel.mockResolvedValueOnce({
      notice: 'quota exceeded',
      blocked: true,
    });

    const budget = new DelegationBudget({});

    // Spy on recordSpawn so we can intercept the returned receipt and spy on rollback.
    const originalRecordSpawn = budget.recordSpawn.bind(budget);
    let rollbackSpy: ReturnType<typeof vi.fn> | undefined;
    vi.spyOn(budget, 'recordSpawn').mockImplementation((...args) => {
      const receipt = originalRecordSpawn(...args);
      rollbackSpy = vi.spyOn(receipt, 'rollback');
      return receipt;
    });

    const executor = makeExecutor(budget);
    const result = await executor.execute(makeCall());

    expect(result.isError).toBe(true);
    expect(rollbackSpy).toBeDefined();
    expect(rollbackSpy).toHaveBeenCalledOnce();
  });

  it('does NOT call rollback() when the usage gate is healthy (not blocked)', async () => {
    // Default mock returns blocked: false — no override needed.
    evaluateDispatchUsageForModel.mockResolvedValueOnce({
      notice: undefined,
      blocked: false,
    });

    const budget = new DelegationBudget({});
    const originalRecordSpawn = budget.recordSpawn.bind(budget);
    let rollbackSpy: ReturnType<typeof vi.fn> | undefined;
    vi.spyOn(budget, 'recordSpawn').mockImplementation((...args) => {
      const receipt = originalRecordSpawn(...args);
      rollbackSpy = vi.spyOn(receipt, 'rollback');
      return receipt;
    });

    const executor = makeExecutor(budget);
    const result = await executor.execute(makeCall());

    // Healthy path: no error from usage gate (subagent ran to completion).
    expect(result.isError).toBeUndefined();
    // rollback must not have been called.
    if (rollbackSpy !== undefined) {
      expect(rollbackSpy).not.toHaveBeenCalled();
    }
  });
});
