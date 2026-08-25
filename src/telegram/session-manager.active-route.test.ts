/**
 * Tests for the resolveActiveRouteForChat helper.
 * @module telegram/session-manager.active-route.test
 */

import { describe, test, expect } from 'vitest';
import { resolveActiveRouteForChat } from './session-manager.active-route.js';
import type { SessionData } from './session-manager.js';

function makeData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    chatId: 1,
    model: 'claude-sonnet' as SessionData['model'],
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

describe('resolveActiveRouteForChat', () => {
  test('returns undefined when no session data exists for the chat', () => {
    const data: SessionData[] = [makeData({ chatId: 999 })];
    expect(resolveActiveRouteForChat(data, 1)).toBeUndefined();
  });

  test('returns undefined for empty data iterable', () => {
    expect(resolveActiveRouteForChat([], 1)).toBeUndefined();
  });

  test('returns General route (no threadId) for a non-topic session', () => {
    const data = [makeData({ chatId: 1, threadId: undefined })];
    const route = resolveActiveRouteForChat(data, 1);
    expect(route).toBeDefined();
    expect(route!.chatId).toBe(1);
    expect(route!.threadId).toBeUndefined();
  });

  test('returns topic route with threadId when a topic session exists', () => {
    const data = [makeData({ chatId: 1, threadId: 42 })];
    const route = resolveActiveRouteForChat(data, 1);
    expect(route).toBeDefined();
    expect(route!.chatId).toBe(1);
    expect(route!.threadId).toBe(42);
  });

  test('returns the most recently active route when multiple topics exist (#1222)', () => {
    // Simulate a chat with sessions on General and two topic threads.
    // Thread 99 was most recently active — auto-subscribe should route there.
    const now = Date.now();
    const data: SessionData[] = [
      makeData({ chatId: 5, threadId: undefined, lastActivity: new Date(now - 3000).toISOString() }),
      makeData({ chatId: 5, threadId: 42,        lastActivity: new Date(now - 1000).toISOString() }),
      makeData({ chatId: 5, threadId: 99,        lastActivity: new Date(now).toISOString() }),
    ];
    const route = resolveActiveRouteForChat(data, 5);
    expect(route).toBeDefined();
    expect(route!.chatId).toBe(5);
    expect(route!.threadId).toBe(99);
  });

  test('ignores sessions from other chats', () => {
    const now = Date.now();
    const data: SessionData[] = [
      makeData({ chatId: 99, threadId: 7, lastActivity: new Date(now + 1000).toISOString() }),
      makeData({ chatId: 5,  threadId: 3, lastActivity: new Date(now).toISOString() }),
    ];
    // chatId 99 is newer but we're resolving for chatId 5
    const route = resolveActiveRouteForChat(data, 5);
    expect(route!.chatId).toBe(5);
    expect(route!.threadId).toBe(3);
  });

  test('non-topic chats produce a General route (byte-identical behavior)', () => {
    // Chats without threadId should return a route without threadId,
    // so sendOptions({ chatId }) === {} — same as before the fix.
    const data = [makeData({ chatId: 7, threadId: undefined })];
    const route = resolveActiveRouteForChat(data, 7);
    expect(route).toBeDefined();
    expect(route).not.toHaveProperty('threadId');
  });
});
