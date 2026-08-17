/**
 * Tests for the elicitation-route-registry module.
 *
 * The registry is the bridge between SDK sessionId and Telegram route used by
 * makeTelegramElicitationHandler to route ask_question prompts to the correct
 * topic thread when multiple topic sessions are active simultaneously.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setElicitationRoute,
  getElicitationRoute,
  clearElicitationRoute,
} from './elicitation-route-registry.js';

// The registry is a module-level singleton, so tests must clean up after themselves.
const SESSION_A = 'sess-aaaa';
const SESSION_B = 'sess-bbbb';
const ROUTE_GENERAL: import('./route.js').TelegramRoute = { chatId: 100 };
const ROUTE_TOPIC: import('./route.js').TelegramRoute = { chatId: 100, threadId: 42 };

describe('elicitation-route-registry', () => {
  beforeEach(() => {
    // Always clean up the test sessions before each test.
    clearElicitationRoute(SESSION_A);
    clearElicitationRoute(SESSION_B);
  });

  it('returns undefined for an unknown sessionId', () => {
    expect(getElicitationRoute(SESSION_A)).toBeUndefined();
  });

  it('stores and retrieves a General-topic route', () => {
    setElicitationRoute(SESSION_A, ROUTE_GENERAL);
    expect(getElicitationRoute(SESSION_A)).toEqual(ROUTE_GENERAL);
  });

  it('stores and retrieves a topic-threaded route', () => {
    setElicitationRoute(SESSION_A, ROUTE_TOPIC);
    const result = getElicitationRoute(SESSION_A);
    expect(result).toEqual(ROUTE_TOPIC);
    expect(result?.threadId).toBe(42);
  });

  it('overwrites a stale route on a second set (idempotent update)', () => {
    setElicitationRoute(SESSION_A, ROUTE_GENERAL);
    setElicitationRoute(SESSION_A, ROUTE_TOPIC);
    expect(getElicitationRoute(SESSION_A)).toEqual(ROUTE_TOPIC);
  });

  it('clears the mapping — subsequent get returns undefined', () => {
    setElicitationRoute(SESSION_A, ROUTE_TOPIC);
    clearElicitationRoute(SESSION_A);
    expect(getElicitationRoute(SESSION_A)).toBeUndefined();
  });

  it('clearElicitationRoute on unknown id is a no-op (no throw)', () => {
    expect(() => clearElicitationRoute('non-existent-session')).not.toThrow();
  });

  it('independently stores routes for different sessions', () => {
    setElicitationRoute(SESSION_A, ROUTE_GENERAL);
    setElicitationRoute(SESSION_B, ROUTE_TOPIC);

    expect(getElicitationRoute(SESSION_A)).toEqual(ROUTE_GENERAL);
    expect(getElicitationRoute(SESSION_B)).toEqual(ROUTE_TOPIC);
  });

  it('clearing one session does not affect another', () => {
    setElicitationRoute(SESSION_A, ROUTE_GENERAL);
    setElicitationRoute(SESSION_B, ROUTE_TOPIC);

    clearElicitationRoute(SESSION_A);

    expect(getElicitationRoute(SESSION_A)).toBeUndefined();
    expect(getElicitationRoute(SESSION_B)).toEqual(ROUTE_TOPIC);
  });
});
