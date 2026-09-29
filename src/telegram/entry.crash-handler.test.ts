/**
 * Tests for the standalone Telegram bot crash notification handler.
 *
 * Fix: #2303 — standalone bot had no uncaughtException / unhandledRejection
 * handlers. Tests confirm that installCrashHandlers() registers both handlers,
 * pushes a Telegram notice with the correct "telegram" prefix, and rate-limits
 * to one push per 60 s — mirroring the daemon's crash-handler contract.
 *
 * No real Telegram messages are sent. pushIfConfigured is fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — isolate push transport
// ---------------------------------------------------------------------------

vi.mock('./push.js', () => ({
  pushIfConfigured: vi.fn(async () => undefined),
  // `push` is imported transitively via tool handlers; export it or Vitest
  // throws "No push export defined on the mock".
  push: vi.fn(async () => undefined),
  pushMarkdown: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { pushIfConfigured } from './push.js';
import { installCrashHandlers } from './entry.js';

const mockPush = vi.mocked(pushIfConfigured);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AnyListener = (...args: unknown[]) => void;

function captureProcessOn(): {
  captured: Record<string, AnyListener[]>;
  restore: () => void;
} {
  const captured: Record<string, AnyListener[]> = {};
  const addedListeners: Array<{ event: string; listener: AnyListener }> = [];

  const origOn = process.on.bind(process);
  const spy = vi.spyOn(process, 'on').mockImplementation((event: string | symbol, listener: AnyListener) => {
    const key = String(event);
    (captured[key] ??= []).push(listener);
    addedListeners.push({ event: key, listener });
    return process;
  });

  return {
    captured,
    restore: () => {
      spy.mockRestore();
      for (const { event, listener } of addedListeners) {
        try {
          (origOn as typeof process.on)(event as NodeJS.Signals, listener as NodeJS.SignalsListener);
        } catch { /* ignore */ }
        process.removeListener(event, listener as AnyListener);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installCrashHandlers (#2303)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockPush.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.resetModules();
  });

  it('registers an uncaughtException handler', () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      expect(captured['uncaughtException']?.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  it('registers an unhandledRejection handler', () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      expect(captured['unhandledRejection']?.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  it('uncaughtException handler calls pushIfConfigured with "telegram" prefix and error text', async () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['uncaughtException'] ?? [];
      expect(handler).toBeDefined();

      handler!(new Error('boom in bot'));
      await Promise.resolve();

      expect(mockPush).toHaveBeenCalledTimes(1);
      const msg = mockPush.mock.calls[0]?.[0] as string;
      expect(msg).toMatch(/agent-afk telegram uncaughtException/);
      expect(msg).toMatch(/boom in bot/);
    } finally {
      restore();
    }
  });

  it('unhandledRejection handler calls pushIfConfigured with "telegram" prefix', async () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['unhandledRejection'] ?? [];
      expect(handler).toBeDefined();

      handler!(new Error('unhandled rejection'));
      await Promise.resolve();

      expect(mockPush).toHaveBeenCalledTimes(1);
      const msg = mockPush.mock.calls[0]?.[0] as string;
      expect(msg).toMatch(/agent-afk telegram unhandledRejection/);
    } finally {
      restore();
    }
  });

  it('rate-limits crash pushes: second call within 60 s is suppressed', async () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['uncaughtException'] ?? [];

      handler!(new Error('first'));
      handler!(new Error('second — within 60 s guard'));
      await Promise.resolve();

      // Only the first push should fire.
      expect(mockPush).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('uncaughtException handler exits with code 1 after notifying', async () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['uncaughtException'] ?? [];

      handler!(new Error('fatal'));
      await Promise.resolve();

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      restore();
    }
  });
});
