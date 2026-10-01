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
