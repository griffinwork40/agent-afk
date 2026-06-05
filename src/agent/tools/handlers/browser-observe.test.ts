/**
 * Tests for the `browser_observe` tool handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBrowserObserveHandler } from './browser-observe.js';
import type { BrowserProvider } from '../../../browser/provider.js';
import type { BrowserObservation } from '../../../browser/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(aborted = false): AbortSignal {
  if (!aborted) return new AbortController().signal;
  const ac = new AbortController();
  ac.abort(new Error('test abort'));
  return ac.signal;
}

function makeObs(overrides: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    observationId: 'obs_2',
    url: 'https://example.com',
    title: 'Example',
    textSummary: 'some text',
    interactive: [],
    status: { httpStatus: 200, loadingState: 'idle', hasDialog: false, consoleErrors: 0 },
    warnings: [],
    screenshotPath: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    name: 'test',
    open: vi.fn(),
    observe: vi.fn().mockResolvedValue(makeObs()),
    act: vi.fn(),
    screenshot: vi.fn(),
    extract: vi.fn(),
    close: vi.fn(),
    describe: vi.fn().mockReturnValue(null),
    shutdown: vi.fn(),
    ...overrides,
  } as BrowserProvider;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('browser_observe handler — input validation', () => {
  const signal = makeSignal();

  it('accepts null/undefined input (all fields optional)', async () => {
    const provider = makeProvider();
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler(null, signal);
    expect(r.isError).toBeUndefined();
  });

  it('accepts empty object input', async () => {
    const provider = makeProvider();
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler({}, signal);
    expect(r.isError).toBeUndefined();
  });

  it('rejects non-object non-null input', async () => {
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn() });
    const r = await handler('string' as unknown, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/must be an object/);
  });

  it('rejects non-boolean screenshot', async () => {
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ screenshot: 1 }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"screenshot" must be a boolean/);
  });

  it('rejects non-boolean include_hidden', async () => {
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ include_hidden: 'yes' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"include_hidden" must be a boolean/);
  });

  it('rejects non-integer max_elements', async () => {
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ max_elements: 3.5 }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"max_elements" must be a positive integer/);
  });

  it('rejects zero max_elements', async () => {
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ max_elements: 0 }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"max_elements" must be a positive integer/);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('browser_observe handler — happy path', () => {
  let provider: BrowserProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('returns JSON observation', async () => {
    const obs = makeObs({ title: 'Fresh Page' });
    vi.mocked(provider.observe).mockResolvedValue(obs);

    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler({}, makeSignal());

    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content as string) as BrowserObservation;
    expect(parsed.title).toBe('Fresh Page');
  });

  it('passes screenshot, includeHidden, maxElements to provider.observe', async () => {
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ screenshot: true, include_hidden: true, max_elements: 20 }, makeSignal());

    expect(provider.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        screenshot: true,
        includeHidden: true,
        maxElements: 20,
      }),
    );
  });

  it('includes sessionId in the observe call', async () => {
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({}, makeSignal());
    expect(provider.observe).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

describe('browser_observe handler — provider errors', () => {
  it('returns isError when provider.observe throws', async () => {
    const provider = makeProvider({ observe: vi.fn().mockRejectedValue(new Error('no page open')) });
    const handler = createBrowserObserveHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no page open/);
  });

  it('returns playwright install hint when error contains ERR_MODULE_NOT_FOUND', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('ERR_MODULE_NOT_FOUND playwright'));
    const handler = createBrowserObserveHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pnpm add playwright/);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe('browser_observe handler — abort signal', () => {
  it('returns immediately when signal is pre-aborted', async () => {
    const getBrowserProvider = vi.fn();
    const handler = createBrowserObserveHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal(true));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/aborted/);
    expect(getBrowserProvider).not.toHaveBeenCalled();
  });
});
