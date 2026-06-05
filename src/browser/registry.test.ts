/**
 * Unit tests for src/browser/registry.ts
 *
 * Strategy: mock `./playwright/index.js` so no real chromium is launched.
 * The fake PlaywrightProvider records calls to `shutdown()` so we can assert
 * on lifecycle behaviour. We also use `__resetBrowserRegistryForTests` in
 * beforeEach to guarantee a clean singleton between tests.
 *
 * NOTE: vitest hoists vi.mock() calls to the top of the module. The mock
 * factory cannot reference module-scope variables declared in the test file
 * because those don't exist yet when hoisting runs. We use a module-scope
 * object (`mockState`) that the factory closes over so the factory can still
 * produce fresh instances per-test without violating the hoisting constraint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable state the hoisted mock factory can close over
// ---------------------------------------------------------------------------

const mockState = {
  shutdownCallCount: 0,
};

// ---------------------------------------------------------------------------
// Module mock — must be declared before any import that transitively loads
// the target module. vi.mock is hoisted by vitest's transformer.
// ---------------------------------------------------------------------------

vi.mock('./playwright/index.js', () => {
  // We can't reference module-scope `let` vars declared AFTER this block
  // because hoisting runs first. We use the `mockState` object (declared
  // before) so the factory stays within the hoisted scope constraint.
  function FakePlaywrightProvider(_config: unknown) {
    // Record that a new instance was created.
    (FakePlaywrightProvider as unknown as { instanceCount: number }).instanceCount =
      ((FakePlaywrightProvider as unknown as { instanceCount: number }).instanceCount ?? 0) + 1;

    return {
      name: 'playwright' as const,
      async shutdown() {
        mockState.shutdownCallCount += 1;
      },
      async open(): Promise<never> { throw new Error('stub'); },
      async observe(): Promise<never> { throw new Error('stub'); },
      async act(): Promise<never> { throw new Error('stub'); },
      async screenshot(): Promise<never> { throw new Error('stub'); },
      async extract(): Promise<never> { throw new Error('stub'); },
      async close(): Promise<void> { /* no-op */ },
      describe() { return null; },
    };
  }
  return { PlaywrightProvider: FakePlaywrightProvider };
});

// ---------------------------------------------------------------------------
// Import registry AFTER mock is installed
// ---------------------------------------------------------------------------

import {
  getBrowserProvider,
  closeBrowserProvider,
  browserProviderActive,
  peekBrowserProvider,
  __resetBrowserRegistryForTests,
} from './registry.js';

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

function resetState(): void {
  __resetBrowserRegistryForTests();
  mockState.shutdownCallCount = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getBrowserProvider()', () => {
  beforeEach(resetState);

  it('returns a BrowserProvider instance with name=playwright', async () => {
    const p = await getBrowserProvider();
    expect(p).toBeDefined();
    expect(p.name).toBe('playwright');
  });

  it('returns the SAME instance on a second call', async () => {
    const p1 = await getBrowserProvider();
    const p2 = await getBrowserProvider();
    expect(p1).toBe(p2);
  });

  it('coalesces 5 concurrent calls to a single instance', async () => {
    const results = await Promise.all([
      getBrowserProvider(),
      getBrowserProvider(),
      getBrowserProvider(),
      getBrowserProvider(),
      getBrowserProvider(),
    ]);

    // All five results are the same object reference.
    const first = results[0];
    expect(first).toBeDefined();
    for (const r of results) {
      expect(r).toBe(first);
    }
  });

  it('installs SIGINT listener after first call', async () => {
    const before = process.listenerCount('SIGINT');
    await getBrowserProvider();
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before + 1);
  });

  it('does NOT install a second SIGINT listener on a second call', async () => {
    await getBrowserProvider();
    const afterFirst = process.listenerCount('SIGINT');
    await getBrowserProvider();
    const afterSecond = process.listenerCount('SIGINT');
    expect(afterSecond).toBe(afterFirst);
  });
});

describe('closeBrowserProvider()', () => {
  beforeEach(resetState);

  it('calls shutdown() on the active provider', async () => {
    await getBrowserProvider();
    expect(mockState.shutdownCallCount).toBe(0);
    await closeBrowserProvider();
    expect(mockState.shutdownCallCount).toBe(1);
  });

  it('nulls the singleton after close', async () => {
    await getBrowserProvider();
    expect(browserProviderActive()).toBe(true);
    await closeBrowserProvider();
    expect(browserProviderActive()).toBe(false);
  });

  it('is a no-op when no provider is active', async () => {
    await expect(closeBrowserProvider()).resolves.toBeUndefined();
    expect(mockState.shutdownCallCount).toBe(0);
  });

  it('removes SIGINT listener after close', async () => {
    await getBrowserProvider();
    const afterGet = process.listenerCount('SIGINT');
    await closeBrowserProvider();
    const afterClose = process.listenerCount('SIGINT');
    expect(afterClose).toBe(afterGet - 1);
  });

  it('is idempotent — second close is a no-op', async () => {
    await getBrowserProvider();
    await closeBrowserProvider();
    await closeBrowserProvider(); // Should not throw or double-shutdown.
    expect(mockState.shutdownCallCount).toBe(1);
  });
});

describe('browserProviderActive()', () => {
  beforeEach(resetState);

  it('returns false before first get', () => {
    expect(browserProviderActive()).toBe(false);
  });

  it('returns true after get', async () => {
    await getBrowserProvider();
    expect(browserProviderActive()).toBe(true);
  });

  it('returns false after close', async () => {
    await getBrowserProvider();
    await closeBrowserProvider();
    expect(browserProviderActive()).toBe(false);
  });
});

describe('peekBrowserProvider()', () => {
  beforeEach(resetState);

  it('returns null before first get', () => {
    expect(peekBrowserProvider()).toBeNull();
  });

  it('returns the provider instance after get', async () => {
    const p = await getBrowserProvider();
    expect(peekBrowserProvider()).toBe(p);
  });

  it('returns null after close', async () => {
    await getBrowserProvider();
    await closeBrowserProvider();
    expect(peekBrowserProvider()).toBeNull();
  });
});

describe('signal handlers', () => {
  beforeEach(resetState);

  it('installs exactly one SIGINT handler across multiple gets', async () => {
    const before = process.listenerCount('SIGINT');
    await getBrowserProvider();
    await getBrowserProvider();
    await getBrowserProvider();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });

  it('installs exactly one SIGTERM handler', async () => {
    const before = process.listenerCount('SIGTERM');
    await getBrowserProvider();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  });
});

describe('__resetBrowserRegistryForTests()', () => {
  beforeEach(resetState);

  it('clears state without calling shutdown', async () => {
    await getBrowserProvider();
    __resetBrowserRegistryForTests();
    expect(browserProviderActive()).toBe(false);
    expect(peekBrowserProvider()).toBeNull();
    expect(mockState.shutdownCallCount).toBe(0);
  });

  it('removes signal handlers', async () => {
    await getBrowserProvider();
    const before = process.listenerCount('SIGINT');
    __resetBrowserRegistryForTests();
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before - 1);
  });

  it('allows re-construction after reset', async () => {
    const p1 = await getBrowserProvider();
    __resetBrowserRegistryForTests();
    const p2 = await getBrowserProvider();
    // Both are valid BrowserProvider instances.
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    // They are distinct objects (fresh construction after reset).
    expect(p1).not.toBe(p2);
  });
});
