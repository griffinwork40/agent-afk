import { describe, it, expect } from 'vitest';
import { AbortCoordinator, CLOSED_SENTINEL } from './abort-coordinator.js';

describe('shared/abort-coordinator', () => {
  describe('begin / clear scope lifecycle', () => {
    it('starts idle, is busy inside a scope, and is idle again after clear', () => {
      const abort = new AbortCoordinator();
      expect(abort.isIdle()).toBe(true);

      const controller = abort.begin();
      expect(abort.isIdle()).toBe(false);
      expect(controller.signal.aborted).toBe(false);

      abort.clear(controller);
      expect(abort.isIdle()).toBe(true);
    });

    it('mints a distinct controller per begin()', () => {
      const abort = new AbortCoordinator();
      const first = abort.begin();
      const second = abort.begin();
      expect(second).not.toBe(first);
    });

    it('clear() is idempotent for the same controller', () => {
      const abort = new AbortCoordinator();
      const controller = abort.begin();
      abort.clear(controller);
      abort.clear(controller);
      expect(abort.isIdle()).toBe(true);
    });
  });

  // The highest-risk invariant this class exists to centralize: a late clear()
  // from an older scope must NOT null a slot a newer begin() already claimed,
  // or compact()'s idle guard would misread "turn in flight" as idle and run
  // summarization mid-turn. Previously hand-rolled at 5 sites in
  // anthropic-direct and 6 in openai-compatible.
  describe('compare-and-clear (stale-scope protection)', () => {
    it('a stale clear() does not release a newer scope', () => {
      const abort = new AbortCoordinator();
      const stale = abort.begin();
      const current = abort.begin();

      abort.clear(stale);

      expect(abort.isIdle()).toBe(false);
      abort.clear(current);
      expect(abort.isIdle()).toBe(true);
    });

    it('clearing an entirely foreign controller is a no-op', () => {
      const abort = new AbortCoordinator();
      const current = abort.begin();
      abort.clear(new AbortController());
      expect(abort.isIdle()).toBe(false);
      abort.clear(current);
      expect(abort.isIdle()).toBe(true);
    });
  });

  describe('requestAbort with a scope in flight', () => {
    it('aborts the current controller with the given reason', () => {
      const abort = new AbortCoordinator();
      const controller = abort.begin();

      abort.requestAbort('interrupted');

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('interrupted');
    });

    it('does not overwrite the reason of an already-aborted scope', () => {
      const abort = new AbortCoordinator();
      const controller = abort.begin();

      abort.requestAbort('interrupted');
      abort.requestAbort('closed');

      expect(controller.signal.reason).toBe('interrupted');
    });
  });

  describe('pending-abort drain (abort arrives between turns)', () => {
    it('parks the reason and fires it on the next begin()', () => {
      const abort = new AbortCoordinator();
      // No scope in flight — this is the interrupt()-between-turns path.
      abort.requestAbort('interrupted');
      expect(abort.isIdle()).toBe(true);

      const controller = abort.begin();
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('interrupted');
    });

    it('drains the parked reason exactly once', () => {
      const abort = new AbortCoordinator();
      abort.requestAbort('closed');

      const first = abort.begin();
      expect(first.signal.aborted).toBe(true);
      abort.clear(first);

      const second = abort.begin();
      expect(second.signal.aborted).toBe(false);
    });

    it('parks a reason when the current scope was already aborted', () => {
      const abort = new AbortCoordinator();
      const controller = abort.begin();
      abort.requestAbort('interrupted');
      expect(controller.signal.aborted).toBe(true);

      // Slot still holds an aborted controller; the next request must park
      // rather than silently no-op, so the following turn still halts.
      abort.requestAbort('closed');
      abort.clear(controller);

      const next = abort.begin();
      expect(next.signal.aborted).toBe(true);
      expect(next.signal.reason).toBe('closed');
    });
  });

  describe('close promise', () => {
    it('resolves with the sentinel once markClosed() fires', async () => {
      const abort = new AbortCoordinator();
      abort.markClosed();
      await expect(abort.closedPromise).resolves.toBe(CLOSED_SENTINEL);
    });

    it('markClosed() is idempotent', async () => {
      const abort = new AbortCoordinator();
      abort.markClosed();
      abort.markClosed();
      await expect(abort.closedPromise).resolves.toBe(CLOSED_SENTINEL);
    });

    it('stays pending until markClosed() is called', async () => {
      const abort = new AbortCoordinator();
      const raced = await Promise.race([
        abort.closedPromise,
        Promise.resolve('still-open' as const),
      ]);
      expect(raced).toBe('still-open');
    });

    it('unblocks a parked race the way the provider main loop uses it', async () => {
      const abort = new AbortCoordinator();
      // Mirrors query.ts: race the next user turn against close().
      const neverResolves = new Promise<'turn'>(() => {});
      setTimeout(() => abort.markClosed(), 0);
      const winner = await Promise.race([neverResolves, abort.closedPromise]);
      expect(winner).toBe(CLOSED_SENTINEL);
    });
  });
});
