/**
 * Unit tests for dispatchSessionStart's injectContext return contract, and
 * integration tests for dispatchStopHook's blocked-path riskCategory
 * forwarding through the emission helpers end-to-end.
 *
 * SessionStart fires during init before any turn exists, so its injectContext
 * cannot be delivered inline; dispatchSessionStart returns the merged string
 * and AgentSession queues it for the first user message (see
 * framework-context-queue.test.ts for the end-to-end delivery test).
 *
 * dispatchStopHook's blocked path: when a Stop handler returns
 * `{ decision: 'block', riskCategory }`, the registry throws HookBlockedError
 * with riskCategory set. emitSessionHookDecision (internal) must forward that
 * field through emitHookDecision into the hook_decision trace row. This
 * end-to-end path was not covered by the unit tests added in PR #4440.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { createHookRegistry } from '../hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import { dispatchSessionStart, dispatchStopHook } from './hooks-dispatch.js';
import type { TraceSink } from '../trace/index.js';

describe('dispatchSessionStart injectContext return', () => {
  it('returns undefined when no registry is provided', async () => {
    expect(await dispatchSessionStart(undefined, { event: 'SessionStart' })).toBeUndefined();
  });

  it('returns undefined when no handler injects context', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({}));
    expect(await dispatchSessionStart(registry, { event: 'SessionStart' })).toBeUndefined();
  });

  it('returns a single handler injectContext value', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({ injectContext: 'hello' }));
    expect(await dispatchSessionStart(registry, { event: 'SessionStart' })).toBe('hello');
  });

  it('returns the merged injectContext across multiple handlers', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({ injectContext: 'one' }));
    registry.register('SessionStart', () => ({ injectContext: 'two' }));
    // Registry concatenates non-blocking handlers' injectContext, joined by '\n'.
    expect(await dispatchSessionStart(registry, { event: 'SessionStart' })).toBe('one\ntwo');
  });

  it('throws HookBlockedError when a handler blocks', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({ decision: 'block', reason: 'nope' }));
    await expect(
      dispatchSessionStart(registry, { event: 'SessionStart' }),
    ).rejects.toBeInstanceOf(HookBlockedError);
  });
});

// Contract: dispatchStopHook blocked-path riskCategory forwarding (issue #4471)
//
// Integration test for the emission helper chain:
//   Stop handler returns { decision: 'block', riskCategory }
//   → registry throws HookBlockedError with .riskCategory populated
//   → dispatchStopHook catch branch calls emitSessionHookDecision(kind:'blocked')
//   → emitSessionHookDecision spreads err.riskCategory into emitHookDecision payload
//   → emitHookDecision writes the hook_decision row (decision:'block' is informative)
//   → TraceSink.write receives { kind:'hook_decision', payload: { riskCategory, ... } }
//
// The four unit tests + registry assertion added in PR #4440 cover individual
// layers; this test confirms the full path from handler decision to trace row.
describe('dispatchStopHook — blocked-path riskCategory forwarding (integration)', () => {
  function makeSink(): { sink: TraceSink; calls: ReturnType<typeof vi.fn> } {
    const write = vi.fn().mockResolvedValue(undefined);
    return { sink: { write } as unknown as TraceSink, calls: write };
  }

  const baseStopContext = {
    event: 'Stop' as const,
    sessionId: 'test-session',
  };

  it('forwards riskCategory from HookBlockedError into the hook_decision trace row', async () => {
    // End-to-end: a Stop handler that blocks with riskCategory must produce a
    // hook_decision row whose payload carries the same riskCategory value.
    const registry = createHookRegistry();
    registry.register('Stop', () => ({
      decision: 'block' as const,
      reason: 'high-risk op detected',
      riskCategory: 'network-mutation' as const,
    }));

    const { sink, calls } = makeSink();

    const result = await dispatchStopHook(registry, baseStopContext, {
      hasNextTurn: true,
      traceWriter: sink,
    });

    // Block is swallowed (non-blocking by contract); wasBlocked flag is set.
    expect(result.wasBlocked).toBe(true);
    expect(result.blockedReason).toBe('high-risk op detected');

    // The trace row must have been written exactly once.
    expect(calls).toHaveBeenCalledTimes(1);
    const [event] = calls.mock.calls[0] as [{ kind: string; payload: Record<string, unknown> }];
    expect(event.kind).toBe('hook_decision');
    expect(event.payload['hookEvent']).toBe('Stop');
    expect(event.payload['decision']).toBe('block');
    expect(event.payload['reason']).toBe('high-risk op detected');
    // The critical assertion — riskCategory must survive the entire emission chain.
    expect(event.payload['riskCategory']).toBe('network-mutation');
  });

  it('omits riskCategory from the trace row when the blocking handler did not supply one', async () => {
    // Confirm the conditional spread (`riskCategory !== undefined`) correctly
    // omits the field rather than forwarding undefined, which would pollute the
    // schema and confuse downstream readers.
    const registry = createHookRegistry();
    registry.register('Stop', () => ({
      decision: 'block' as const,
      reason: 'policy-denied',
    }));

    const { sink, calls } = makeSink();

    const result = await dispatchStopHook(registry, baseStopContext, {
      hasNextTurn: true,
      traceWriter: sink,
    });

    expect(result.wasBlocked).toBe(true);
    expect(calls).toHaveBeenCalledTimes(1);
    const [event] = calls.mock.calls[0] as [{ kind: string; payload: Record<string, unknown> }];
    expect(event.kind).toBe('hook_decision');
    expect(event.payload['decision']).toBe('block');
    // Must be absent, not undefined — the spread must not include the key at all.
    expect(Object.prototype.hasOwnProperty.call(event.payload, 'riskCategory')).toBe(false);
  });

  it('forwards riskCategory for every RiskCategory value that is structurally distinct', async () => {
    // Spot-check two additional categories to confirm the forwarding is not
    // accidentally hard-coded to a single value.
    const categories = ['credential-path', 'bash-destructive'] as const;

    for (const riskCategory of categories) {
      const registry = createHookRegistry();
      registry.register('Stop', () => ({ decision: 'block' as const, riskCategory }));

      const { sink, calls } = makeSink();
      await dispatchStopHook(registry, baseStopContext, { hasNextTurn: true, traceWriter: sink });

      expect(calls).toHaveBeenCalledTimes(1);
      const [event] = calls.mock.calls[0] as [{ kind: string; payload: Record<string, unknown> }];
      expect(event.payload['riskCategory']).toBe(riskCategory);
    }
  });

  it('does not write a trace row when no traceWriter is provided', async () => {
    // Confirm the no-op guard in emitHookDecision is respected — the blocked
    // path must not throw when traceWriter is absent.
    const registry = createHookRegistry();
    registry.register('Stop', () => ({
      decision: 'block' as const,
      riskCategory: 'workspace-write' as const,
    }));

    const result = await dispatchStopHook(registry, baseStopContext, {
      hasNextTurn: true,
      // traceWriter intentionally omitted
    });

    expect(result.wasBlocked).toBe(true);
    // No throw — the path is safe without a writer.
  });
});
