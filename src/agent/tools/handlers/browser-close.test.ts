/**
 * Tests for the `browser_close` tool handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBrowserCloseHandler } from './browser-close.js';
import type { BrowserProvider } from '../../../browser/provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(aborted = false): AbortSignal {
  if (!aborted) return new AbortController().signal;
  const ac = new AbortController();
  ac.abort(new Error('test abort'));
  return ac.signal;
}

function makeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    name: 'test',
    open: vi.fn(),
    observe: vi.fn(),
    act: vi.fn(),
    screenshot: vi.fn(),
    extract: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockReturnValue(null),
    shutdown: vi.fn(),
    ...overrides,
  } as BrowserProvider;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('browser_close handler — happy path', () => {
  it('returns success message when close succeeds', async () => {
    const provider = makeProvider();
    const handler = createBrowserCloseHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('Browser session closed.');
  });

  it('passes sessionId to provider.close', async () => {
    const provider = makeProvider();
    const handler = createBrowserCloseHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({}, makeSignal());

    expect(provider.close).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });

  it('accepts null/undefined input (no required fields)', async () => {
    const provider = makeProvider();
    const handler = createBrowserCloseHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler(null, makeSignal());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('Browser session closed.');
  });

  it('ignores any extra input fields', async () => {
    const provider = makeProvider();
    const handler = createBrowserCloseHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ extra_field: 'ignored' }, makeSignal());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('Browser session closed.');
  });
});

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

describe('browser_close handler — provider errors', () => {
  it('returns isError when provider.close throws', async () => {
    const provider = makeProvider({ close: vi.fn().mockRejectedValue(new Error('context already torn down')) });
    const handler = createBrowserCloseHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/context already torn down/);
  });

  it('returns isError when getBrowserProvider throws', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('provider crashed'));
    const handler = createBrowserCloseHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/provider crashed/);
  });

  it('returns playwright install hint on ERR_MODULE_NOT_FOUND', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('ERR_MODULE_NOT_FOUND playwright'));
    const handler = createBrowserCloseHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pnpm add playwright/);
  });

  it('returns playwright install hint on Cannot find package', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('Cannot find package playwright'));
    const handler = createBrowserCloseHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pnpm add playwright/);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe('browser_close handler — abort signal', () => {
  it('returns immediately when signal is pre-aborted', async () => {
    const getBrowserProvider = vi.fn();
    const handler = createBrowserCloseHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal(true));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/aborted/);
    expect(getBrowserProvider).not.toHaveBeenCalled();
  });
});
