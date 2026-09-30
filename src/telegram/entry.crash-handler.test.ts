/**
 * Tests for the standalone Telegram bot crash notification handler.
 *
 * Fix: #2303 — standalone bot had no uncaughtException / unhandledRejection
 * handlers. Tests confirm that installCrashHandlers() registers both handlers,
 * pushes a Telegram notice with the correct "telegram" prefix, and rate-limits
 * to one push per 60 s — mirroring the daemon's crash-handler contract.
 *
 * Fix: #2513 — two advisory findings addressed:
 *   1. Re-entry guard: a module-scoped `crashHandlersInstalled` flag prevents
 *      duplicate listener registration on repeated calls.
 *   2. Deferred exit: process.exit(1) now fires after a 200 ms setTimeout so
 *      the fire-and-forget push HTTP request has a chance to flush before the
 *      process terminates.
 *
 * Fix: #2576 — three advisory findings addressed:
 *   1. process.exitCode = 1 is set before the unref'd timer so supervisors
 *      (launchd KeepAlive / systemd Restart=on-failure) see a non-zero code
 *      even when the process exits naturally before the timer fires.
 *   2. vi.useFakeTimers() moved from test bodies into beforeEach.
 *   3. vi.useRealTimers() / vi.clearAllTimers() remain in afterEach (unchanged).
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
import { installCrashHandlers, _resetCrashHandlersForTest } from './entry.js';

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

describe('installCrashHandlers (#2303, #2513, #2576)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockPush.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => undefined as never);
    // Reset module-scoped re-entry guard so each test starts from a clean state.
    _resetCrashHandlersForTest();
    // Reset exitCode so tests that check it start from a known-clean state.
    process.exitCode = undefined;
    // Install fake timers here so every test that exercises timers gets them
    // automatically, without needing an inline vi.useFakeTimers() call.
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Clear any pending timers (e.g. the deferred process.exit setTimeout) before
    // restoring real timers — prevents leaked 200 ms real timers from firing after
    // the spy is restored and triggering "process.exit unexpectedly called" errors
    // in the vitest runner between tests.
    vi.clearAllTimers();
    exitSpy.mockRestore();
    vi.useRealTimers();
    vi.resetModules();
    // Restore exitCode so other test files aren't affected.
    process.exitCode = undefined;
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

  it('uncaughtException handler defers process.exit(1) by ~200 ms so the push can flush', async () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['uncaughtException'] ?? [];

      handler!(new Error('fatal'));
      await Promise.resolve();

      // Exit must NOT have fired immediately.
      expect(exitSpy).not.toHaveBeenCalled();

      // Advance past the delay — exit should fire now.
      vi.advanceTimersByTime(200);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      restore();
    }
  });

  it('unhandledRejection handler defers process.exit(1) by ~200 ms so the push can flush', async () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['unhandledRejection'] ?? [];

      handler!(new Error('unhandled'));
      await Promise.resolve();

      expect(exitSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      restore();
    }
  });

  it('re-entry guard: second installCrashHandlers() call registers no additional listeners', () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const countAfterFirst = (captured['uncaughtException'] ?? []).length;

      // Second call should be a no-op.
      installCrashHandlers();
      const countAfterSecond = (captured['uncaughtException'] ?? []).length;

      expect(countAfterSecond).toBe(countAfterFirst);
    } finally {
      restore();
    }
  });

  it('uncaughtException handler sets process.exitCode = 1 immediately (before timer)', () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['uncaughtException'] ?? [];

      // exitCode starts undefined (reset in beforeEach).
      expect(process.exitCode).toBeUndefined();

      handler!(new Error('crash'));

      // exitCode must be set synchronously — before any timer fires.
      expect(process.exitCode).toBe(1);
      // Timer has not fired yet.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('unhandledRejection handler sets process.exitCode = 1 immediately (before timer)', () => {
    const { captured, restore } = captureProcessOn();
    try {
      installCrashHandlers();
      const [handler] = captured['unhandledRejection'] ?? [];

      expect(process.exitCode).toBeUndefined();

      handler!(new Error('rejection'));

      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
