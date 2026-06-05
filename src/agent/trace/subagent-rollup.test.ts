/**
 * Tests for the subagent token / cost rollup in `session_sealed`.
 *
 * Verifies that `AgentSession.recordSubagentCompletion` accumulates
 * correctly and that the accumulated data surfaces in the `session_sealed`
 * event emitted by `writer.seal()`.
 *
 * Uses `InMemoryTraceWriter` + `AgentSession` directly, following the
 * pattern established by `integration.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentConfig } from '../types.js';
import { createMockProvider, type MockProviderHandle } from '../__fixtures__/mock-provider.js';
import { InMemoryTraceWriter } from './writer.js';

vi.mock('../../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

import { AgentSession } from '../session.js';

describe('AgentSession.recordSubagentCompletion → session_sealed rollup', () => {
  let provider: MockProviderHandle;
  let writer: InMemoryTraceWriter;
  let config: AgentConfig;

  beforeEach(() => {
    provider = createMockProvider();
    writer = new InMemoryTraceWriter();
    config = {
      model: 'sonnet',
      apiKey: 'test-key',
      provider,
      traceWriter: writer,
    };
  });

  it('session_sealed omits rollup fields when no subagents completed', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCount).toBeUndefined();
    expect(sealed.payload.subagentTokens).toBeUndefined();
    expect(sealed.payload.subagentCostUsd).toBeUndefined();
  });

  it('session_sealed includes subagentCount after one completion', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion(undefined, undefined);
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCount).toBe(1);
  });

  it('accumulates subagentCount across multiple completions', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion();
    session.recordSubagentCompletion();
    session.recordSubagentCompletion();
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCount).toBe(3);
  });

  it('accumulates token counts from multiple subagents', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion({ inputTokens: 1000, outputTokens: 200 });
    session.recordSubagentCompletion({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 50 });
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentTokens?.input).toBe(1500);
    expect(sealed.payload.subagentTokens?.output).toBe(300);
    expect(sealed.payload.subagentTokens?.cacheRead).toBe(50);
    expect(sealed.payload.subagentTokens?.cacheCreation).toBeUndefined();
  });

  it('accumulates cost from multiple subagents', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion(undefined, 0.05);
    session.recordSubagentCompletion(undefined, 0.03);
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    // Floating point: use toBeCloseTo
    expect(sealed.payload.subagentCostUsd).toBeCloseTo(0.08, 10);
  });

  it('omits subagentTokens field when all token counts are zero', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    // usage with all-zero counts
    session.recordSubagentCompletion({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    // Count increments, but tokens omitted (all zeros)
    expect(sealed.payload.subagentCount).toBe(1);
    expect(sealed.payload.subagentTokens).toBeUndefined();
  });

  it('omits subagentCostUsd when cost is zero', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion(undefined, 0);
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCostUsd).toBeUndefined();
  });

  it('ignores NaN and Infinity in token counts', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion({ inputTokens: NaN, outputTokens: Infinity });
    session.recordSubagentCompletion({ inputTokens: 100 });
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    // Only the finite 100 should accumulate
    expect(sealed.payload.subagentTokens?.input).toBe(100);
    expect(sealed.payload.subagentTokens?.output).toBeUndefined();
  });

  it('ignores NaN cost', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion(undefined, NaN);
    session.recordSubagentCompletion(undefined, 0.02);
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCostUsd).toBeCloseTo(0.02, 10);
  });

  it('accumulates cache creation tokens', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.recordSubagentCompletion({ cacheCreationTokens: 800 });
    session.recordSubagentCompletion({ cacheCreationTokens: 200 });
    await session.close();

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentTokens?.cacheCreation).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// SubagentManager.setOnSubagentSucceeded wiring
// ---------------------------------------------------------------------------

describe('SubagentManager.setOnSubagentSucceeded', () => {
  it('exposes a callable setter that can be invoked after construction', async () => {
    // Shallow test: just verify the method exists and accepts a callback.
    // Full end-to-end wiring is tested via bootstrap integration tests.
    const { SubagentManager } = await vi.importActual<typeof import('../subagent.js')>('../subagent.js');
    const manager = new SubagentManager({});
    let called = false;
    manager.setOnSubagentSucceeded(() => { called = true; });
    // Nothing fires until a subagent succeeds — just verify no throw.
    expect(called).toBe(false);
  });
});
