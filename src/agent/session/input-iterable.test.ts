/**
 * Tests for QueryInputStream — single-message fast-path and FIFO multi-push.
 *
 * Regression guard: before the bufferedMessages[] FIFO, a second pushUserMessage
 * would silently clobber the first. These tests enforce ordering.
 */

import { describe, it, expect } from 'vitest';
import { QueryInputStream } from './input-iterable.js';

describe('QueryInputStream', () => {
  describe('single-message fast-path (pendingResolve is live)', () => {
    it('resolves immediately when a consumer is waiting', async () => {
      const stream = new QueryInputStream(() => 'sess-1');
      const iter = stream.createIterable()[Symbol.asyncIterator]();

      // Start waiting for next — sets pendingResolve
      const nextPromise = iter.next();

      // Push while consumer is waiting → should resolve immediately
      stream.pushUserMessage('hello');

      const result = await nextPromise;
      expect(result.done).toBe(false);
      expect(result.value.content).toBe('hello');
      expect(result.value.sessionId).toBe('sess-1');
    });
  });

  describe('FIFO multi-push (no consumer waiting)', () => {
    it('delivers messages in push order when next() is called after both pushes', async () => {
      const stream = new QueryInputStream(() => undefined);
      const iter = stream.createIterable()[Symbol.asyncIterator]();

      // Push two messages before any next() call
      stream.pushUserMessage('first');
      stream.pushUserMessage('second');

      const r1 = await iter.next();
      const r2 = await iter.next();

      expect(r1.done).toBe(false);
      expect(r1.value.content).toBe('first');

      expect(r2.done).toBe(false);
      expect(r2.value.content).toBe('second');
    });

    it('does not set sessionId when getter returns undefined', async () => {
      const stream = new QueryInputStream(() => undefined);
      stream.pushUserMessage('msg');
      const iter = stream.createIterable()[Symbol.asyncIterator]();
      const result = await iter.next();
      expect(result.value.sessionId).toBeUndefined();
    });

    it('preserves ordering between queued parent input and injected framework context', async () => {
      const stream = new QueryInputStream(() => 'parent-session');
      const iter = stream.createIterable()[Symbol.asyncIterator]();

      stream.pushUserMessage('human-authored parent message');
      stream.pushUserMessage('[framework-generated context: injected note]');

      const first = await iter.next();
      const second = await iter.next();

      expect(first.value.content).toBe('human-authored parent message');
      expect(second.value.content).toBe('[framework-generated context: injected note]');
      expect(first.value.sessionId).toBe('parent-session');
      expect(second.value.sessionId).toBe('parent-session');
    });

    it('sets sessionId when getter returns a value', async () => {
      const stream = new QueryInputStream(() => 'my-session');
      stream.pushUserMessage('msg');
      const iter = stream.createIterable()[Symbol.asyncIterator]();
      const result = await iter.next();
      expect(result.value.sessionId).toBe('my-session');
    });
  });
});
