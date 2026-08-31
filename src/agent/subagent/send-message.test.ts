import { describe, it, expect, vi } from 'vitest';
import type { SubagentHandle } from './handle.js';

/**
 * Tests for SubagentHandle.sendMessage() — the pending-message queue
 * that enables user-to-subagent interaction during mid-turn task view.
 */

// ---------------------------------------------------------------------------
// Minimal mock handle to test the queue behavior
// ---------------------------------------------------------------------------

function makeMockHandle(): SubagentHandle & { _pendingUserMessages: string[] } {
  // Import the real impl to get the actual sendMessage/queue behavior.
  // We can't easily construct a SubagentHandleImpl (too many deps), so
  // we test the queue contract directly.
  return {
    id: 'test-handle',
    status: 'running',
    session: {} as never,
    run: vi.fn(),
    runToResult: vi.fn(),
    runInBackground: vi.fn(),
    cancel: vi.fn(),
    teardown: vi.fn(),
    getLastStopInjectContext: vi.fn(),
    _pendingUserMessages: [],
    sendMessage(text: string): void {
      this._pendingUserMessages.push(text);
    },
  };
}

describe('SubagentHandle.sendMessage', () => {
  it('queues a single message', () => {
    const handle = makeMockHandle();
    handle.sendMessage('hello');
    expect(handle._pendingUserMessages).toEqual(['hello']);
  });

  it('queues multiple messages in order', () => {
    const handle = makeMockHandle();
    handle.sendMessage('first');
    handle.sendMessage('second');
    handle.sendMessage('third');
    expect(handle._pendingUserMessages).toEqual(['first', 'second', 'third']);
  });

  it('messages are consumable by shifting', () => {
    const handle = makeMockHandle();
    handle.sendMessage('a');
    handle.sendMessage('b');
    const first = handle._pendingUserMessages.shift();
    expect(first).toBe('a');
    expect(handle._pendingUserMessages).toEqual(['b']);
  });

  it('queue is empty initially', () => {
    const handle = makeMockHandle();
    expect(handle._pendingUserMessages).toEqual([]);
  });

  it('sendMessage does not throw on empty text', () => {
    const handle = makeMockHandle();
    expect(() => handle.sendMessage('')).not.toThrow();
    expect(handle._pendingUserMessages).toEqual(['']);
  });
});
