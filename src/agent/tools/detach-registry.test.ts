/**
 * Unit tests for DetachableToolRegistry (#2542).
 *
 * Covers:
 *  - register / hasDetachable / listRunning
 *  - detachAll: fires detachSignal on all running tokens (Invariant:D1)
 *  - token lifecycle: notifyDetached → deliver → settled event
 *  - cancelAll: session-end cleanup fires abort on all tokens
 *  - parallel-batch: multiple tokens detached in one pass
 *  - completed-before-detach: token that settled before detachAll is skipped
 *
 * @module agent/tools/detach-registry.test
 */

import { describe, expect, it, vi } from 'vitest';
import { DetachableToolRegistry, type DetachedToolResult } from './detach-registry.js';

function makeResult(toolUseId: string): DetachedToolResult {
  return {
    toolUseId,
    label: `echo ${toolUseId}`,
    status: 'completed',
    output: 'hello',
    exitCode: 0,
    durationMs: 100,
  };
}

describe('DetachableToolRegistry', () => {
  describe('register / hasDetachable / listRunning', () => {
    it('registers a token and reports it as in-flight', () => {
      const registry = new DetachableToolRegistry();
      expect(registry.hasDetachable()).toBe(false);

      registry.register('call-1');
      expect(registry.hasDetachable()).toBe(true);
      expect(registry.listRunning()).toEqual(['call-1']);
    });

    it('tracks multiple concurrent tokens', () => {
      const registry = new DetachableToolRegistry();
      registry.register('call-1');
      registry.register('call-2');
      expect(registry.listRunning().sort()).toEqual(['call-1', 'call-2']);
    });

    it('removes token after deliver()', () => {
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1');
      token.notifyDetached();
      token.deliver(makeResult('call-1'));
      expect(registry.hasDetachable()).toBe(false);
      expect(registry.listRunning()).toEqual([]);
    });
  });

  describe('detach flow: detachAll fires signal, handler detaches', () => {
    it('aborts detachSignal on all running tokens (Invariant:D1 — parallel batch)', () => {
      const registry = new DetachableToolRegistry();
      const t1 = registry.register('call-1');
      const t2 = registry.register('call-2');

      const aborted: string[] = [];
      t1.detachSignal.addEventListener('abort', () => aborted.push('call-1'));
      t2.detachSignal.addEventListener('abort', () => aborted.push('call-2'));

      registry.detachAll();

      expect(aborted.sort()).toEqual(['call-1', 'call-2']);
    });

    it('shouldDetach() is false before detachAll, true after', () => {
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1');

      expect(token.shouldDetach()).toBe(false);
      registry.detachAll();
      expect(token.shouldDetach()).toBe(true);
    });

    it('detachResult returns a JSON-parseable content string with toolUseId', () => {
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1');

      const result = token.detachResult('echo hello');
      const parsed = JSON.parse(result.content) as { status: string; toolUseId: string; label: string };
      expect(parsed.status).toBe('detached');
      expect(parsed.toolUseId).toBe('call-1');
      expect(parsed.label).toBe('echo hello');
      expect(parsed.message).toContain('background');
    });
  });

  describe('deliver and settled event', () => {
    it('emits "settled" event when deliver() is called', () => {
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1');

      const settledResults: DetachedToolResult[] = [];
      registry.on('settled', (r: DetachedToolResult) => settledResults.push(r));

      token.notifyDetached();
      token.deliver(makeResult('call-1'));

      expect(settledResults).toHaveLength(1);
      expect(settledResults[0]!.toolUseId).toBe('call-1');
      expect(settledResults[0]!.status).toBe('completed');
    });

    it('deliver() is idempotent — settled event fires only once', () => {
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1');

      const listener = vi.fn();
      registry.on('settled', listener);

      token.notifyDetached();
      token.deliver(makeResult('call-1'));
      token.deliver(makeResult('call-1')); // second call: ignored

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelAll: session-end cleanup', () => {
    it('aborts all token detach signals and clears the registry', () => {
      const registry = new DetachableToolRegistry();
      const t1 = registry.register('call-1');
      const t2 = registry.register('call-2');

      const aborted: string[] = [];
      t1.detachSignal.addEventListener('abort', () => aborted.push('call-1'));
      t2.detachSignal.addEventListener('abort', () => aborted.push('call-2'));

      registry.cancelAll();

      expect(aborted.sort()).toEqual(['call-1', 'call-2']);
      expect(registry.hasDetachable()).toBe(false);
    });

    it('cancelAll is a no-op on an empty registry', () => {
      const registry = new DetachableToolRegistry();
      expect(() => registry.cancelAll()).not.toThrow();
    });
  });

  describe('deregister: normal-close cleanup (Fix #2)', () => {
    it('deregister removes the token so hasDetachable() is false', () => {
      const registry = new DetachableToolRegistry();
      registry.register('call-1');
      expect(registry.hasDetachable()).toBe(true);

      registry.deregister('call-1');

      expect(registry.hasDetachable()).toBe(false);
      expect(registry.listRunning()).toEqual([]);
    });

    it('deregister on an unknown id is a no-op (does not throw)', () => {
      const registry = new DetachableToolRegistry();
      expect(() => registry.deregister('nonexistent')).not.toThrow();
    });

    it('deregister on an already-settled token is a no-op (token already removed by deliver)', () => {
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1');
      token.notifyDetached();
      token.deliver(makeResult('call-1')); // deliver() removes from map, sets status='settled'

      // deregister should not throw and hasDetachable should stay false
      expect(() => registry.deregister('call-1')).not.toThrow();
      expect(registry.hasDetachable()).toBe(false);
    });
  });

  describe('cancelAll: status-gating (Fix #4)', () => {
    it('aborts running tokens but NOT already-detached tokens detach signals', () => {
      const registry = new DetachableToolRegistry();
      const t1 = registry.register('call-1'); // stays 'running'
      const t2 = registry.register('call-2');
      t2.notifyDetached(); // transitions to 'detached'

      // Track whether t2's detach signal gets aborted by cancelAll
      let t2SignalAborted = false;
      // Note: t2 was never detachAll()'d so its signal is NOT yet aborted
      t2.detachSignal.addEventListener('abort', () => { t2SignalAborted = true; });

      registry.cancelAll();

      // Running token's detach signal should have been fired
      expect(t1.detachSignal.aborted).toBe(true);
      // Detached token's signal must NOT be newly aborted by cancelAll
      expect(t2SignalAborted).toBe(false);
      expect(t2.detachSignal.aborted).toBe(false);
      // Registry is cleared
      expect(registry.hasDetachable()).toBe(false);
    });

    it('cancelAll on a detached token prevents a late deliver() from emitting settled', () => {
      // Regression: before the fix, cancelAll() only cleared the map but did not
      // mark tokens settled. A detached token's deliver() closure holds the token
      // object directly, so it bypassed the map lookup and still passed the
      // _status !== 'settled' guard — emitting 'settled' after session teardown.
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1');
      token.notifyDetached(); // _status: 'running' → 'detached'

      registry.cancelAll();

      // Simulate the late proc.once('close') deliver() call that races teardown
      const settled: DetachedToolResult[] = [];
      registry.on('settled', (r: DetachedToolResult) => settled.push(r));
      token.deliver(makeResult('call-1'));

      expect(settled).toHaveLength(0);
    });

    it('cancelAll aborts a running token so its deliver() also becomes a no-op', () => {
      const registry = new DetachableToolRegistry();
      const token = registry.register('call-1'); // stays 'running'

      registry.cancelAll();

      // detach abort signal must have fired for running tokens
      expect(token.detachSignal.aborted).toBe(true);

      // Late deliver() must not emit settled
      const settled: DetachedToolResult[] = [];
      registry.on('settled', (r: DetachedToolResult) => settled.push(r));
      token.deliver(makeResult('call-1'));

      expect(settled).toHaveLength(0);
    });
  });

  describe('parallel-batch semantics (Invariant:D1)', () => {
    it('does not partially detach: a token that completes before detachAll is skipped', () => {
      const registry = new DetachableToolRegistry();
      const t1 = registry.register('call-1');
      const t2 = registry.register('call-2');

      // t1 completes normally before Ctrl+B fires
      t1.notifyDetached();
      t1.deliver(makeResult('call-1'));

      const aborted: string[] = [];
      // t1's signal was created before deliver(); it does NOT get re-fired
      t1.detachSignal.addEventListener('abort', () => aborted.push('call-1'));
      t2.detachSignal.addEventListener('abort', () => aborted.push('call-2'));

      registry.detachAll();

      // Only t2 (still in-flight) receives the detach signal; t1 already left the registry
      expect(aborted).toEqual(['call-2']);
    });
  });
});
