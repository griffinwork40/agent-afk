/**
 * Unit tests for C6 budget enforcement in transformProviderEvent, plus
 * targeted transform tests for individual ProviderEvent cases.
 *
 * PR #203 removed the MessageQueue/consumeSdkStream architecture and replaced
 * it with a synchronous `transformProviderEvent` called directly by the
 * session's iterator loop. Budget enforcement is preserved: cost is accumulated
 * in `deps._runningCostUsd` across calls, and once the ceiling is crossed,
 * `abortBudget()` is called and an `{ type: 'error' }` OutputEvent is returned
 * (which the loop treats as a terminal event).
 *
 * Verifies that:
 * - abortBudget is called and an error OutputEvent is returned when the
 *   accumulated cost across turn.completed events crosses maxBudgetUsd.
 * - The gate correctly accumulates cost across multiple turns (not just
 *   the latest turn's cost) via the shared deps._runningCostUsd field.
 * - abortBudget is NOT called when totalCostUsd is undefined (provider
 *   doesn't supply cost — graceful no-op, not silent enforcement).
 * - abortBudget is NOT called when the running total is below the ceiling.
 * - abortBudget is NOT called when maxBudgetUsd is undefined (uncapped).
 * - The boundary condition (cost === ceiling) triggers abort.
 * - tool.diff ProviderEvents are transformed to tool_diff chunks with the
 *   diff payload preserved verbatim.
 *
 * @module agent/session/stream-consumer-budget.test
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProviderEvent, ProviderUsage } from '../provider.js';
import type { TransformDeps } from './stream-consumer.js';
import { transformProviderEvent } from './stream-consumer.js';
import { BudgetExceededError } from '../../utils/errors.js';
import type { Message, SessionMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeSessionMetadata(): SessionMetadata {
  return {
    sessionId: 'test-session',
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'default',
  };
}

/**
 * Build the minimal TransformDeps for budget tests.
 * A single deps object is reused across calls to simulate per-session state
 * (the _runningCostUsd accumulator lives on deps).
 */
function makeDeps(opts: {
  maxBudgetUsd?: number;
  abortBudget?: (reason: string) => void;
} = {}): TransformDeps {
  let sessionMeta = makeSessionMetadata();
  const history: Message[] = [];

  return {
    conversationHistory: history,
    getSessionMetadata: () => sessionMeta,
    setSessionMetadata: (updater) => { sessionMeta = updater(sessionMeta); },
    updateSessionIdentity: vi.fn(),
    resolveInitialization: vi.fn(),
    setLastResponseMetadata: vi.fn(),
    maxBudgetUsd: opts.maxBudgetUsd,
    abortBudget: opts.abortBudget,
    _runningCostUsd: 0,
  };
}

/**
 * Build a minimal `turn.completed` event with the given cost.
 */
function makeTurnCompleted(
  totalCostUsd: number | undefined,
  sessionId = 'test-session',
): ProviderEvent {
  const usage: ProviderUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    stopReason: 'end_turn',
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
  return { type: 'turn.completed', usage, sessionId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transformProviderEvent — budget enforcement (C6)', () => {
  it('calls abortBudget and returns error OutputEvent when cost exceeds ceiling on first turn', () => {
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.02, abortBudget });

    const result = transformProviderEvent(makeTurnCompleted(0.05), deps);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('error');
    expect((result as { type: 'error'; error: Error }).error).toBeInstanceOf(BudgetExceededError);

    expect(abortBudget).toHaveBeenCalledOnce();
    const reason = abortBudget.mock.calls[0]![0] as string;

    // Must contain the accumulated cost and the ceiling.
    expect(reason).toContain('0.0500');
    expect(reason).toContain('0.0200');
    // Must be readable — not just numbers.
    expect(reason.toLowerCase()).toMatch(/budget|ceiling|limit/);
  });

  it('accumulates cost across multiple turns before triggering', () => {
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.08, abortBudget });

    // Turn 1: running = 0.03, below 0.08
    const r1 = transformProviderEvent(makeTurnCompleted(0.03), deps);
    expect(r1?.type).toBe('done');
    expect(abortBudget).not.toHaveBeenCalled();

    // Turn 2: running = 0.06, below 0.08
    const r2 = transformProviderEvent(makeTurnCompleted(0.03), deps);
    expect(r2?.type).toBe('done');
    expect(abortBudget).not.toHaveBeenCalled();

    // Turn 3: running = 0.09, exceeds 0.08 → abort
    const r3 = transformProviderEvent(makeTurnCompleted(0.03), deps);
    expect(r3?.type).toBe('error');
    expect(abortBudget).toHaveBeenCalledOnce();

    const reason = abortBudget.mock.calls[0]![0] as string;
    expect(reason).toContain('0.0900');
    expect(reason).toContain('0.0800');
  });

  it('does NOT call abortBudget when total remains below ceiling', () => {
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.05, abortBudget });

    const r1 = transformProviderEvent(makeTurnCompleted(0.01), deps);
    expect(r1?.type).toBe('done');

    const r2 = transformProviderEvent(makeTurnCompleted(0.01), deps);
    expect(r2?.type).toBe('done');

    expect(abortBudget).not.toHaveBeenCalled();
  });

  it('does NOT call abortBudget when totalCostUsd is undefined (cost unavailable)', () => {
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.001, abortBudget });

    const result = transformProviderEvent(makeTurnCompleted(undefined), deps);
    // Should complete normally, not abort
    expect(result?.type).toBe('done');
    expect(abortBudget).not.toHaveBeenCalled();
  });

  it('does NOT call abortBudget when maxBudgetUsd is undefined (uncapped)', () => {
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: undefined, abortBudget });

    const result = transformProviderEvent(makeTurnCompleted(9999), deps);
    expect(result?.type).toBe('done');
    expect(abortBudget).not.toHaveBeenCalled();
  });

  it('fires exactly at the boundary: cost equal to ceiling triggers abort', () => {
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.05, abortBudget });

    const result = transformProviderEvent(makeTurnCompleted(0.05), deps);

    expect(result?.type).toBe('error');
    expect(abortBudget).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// tool.diff event transform
// ---------------------------------------------------------------------------

describe('tool.diff event transform', () => {
  it('transforms tool.diff provider event to a tool_diff chunk with payload preserved', () => {
    const deps = makeDeps();
    const minimalDiff = { hunks: [], addedLines: 0, removedLines: 0 };
    const event = {
      type: 'tool.diff' as const,
      toolUseId: 'tu-123',
      diff: minimalDiff,
      sessionId: 'sess-abc',
    };
    const result = transformProviderEvent(event, deps);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('chunk');
    if (result!.type === 'chunk') {
      expect(result!.chunk.type).toBe('tool_diff');
      if (result!.chunk.type === 'tool_diff') {
        expect(result!.chunk.toolUseId).toBe('tu-123');
        expect(result!.chunk.diff).toEqual(minimalDiff);
      }
    }
  });
});
