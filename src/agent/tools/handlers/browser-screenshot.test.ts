/**
 * Tests for the `browser_screenshot` tool handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBrowserScreenshotHandler } from './browser-screenshot.js';
import type { BrowserProvider } from '../../../browser/provider.js';
import type { ScreenshotResult } from '../../../browser/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(aborted = false): AbortSignal {
  if (!aborted) return new AbortController().signal;
  const ac = new AbortController();
  ac.abort(new Error('test abort'));
  return ac.signal;
}

function makeScreenshotResult(overrides: Partial<ScreenshotResult> = {}): ScreenshotResult {
  return {
    path: '/home/user/.afk/state/witness/default/browser/screenshots/snap-001.png',
    bytes: 42000,
    width: 1280,
    height: 800,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    name: 'test',
    open: vi.fn(),
    observe: vi.fn(),
    act: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(makeScreenshotResult()),
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

describe('browser_screenshot handler — input validation', () => {
  const signal = makeSignal();

  it('accepts null/undefined (all fields optional)', async () => {
    const provider = makeProvider();
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler(null, signal);
    expect(r.isError).toBeUndefined();
  });

  it('accepts empty object', async () => {
    const provider = makeProvider();
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler({}, signal);
    expect(r.isError).toBeUndefined();
  });

  it('rejects non-object non-null input', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn() });
    const r = await handler(42 as unknown, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/must be an object/);
  });

  it('rejects non-boolean full_page', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ full_page: 'yes' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"full_page" must be a boolean/);
  });

  it('rejects target with invalid kind', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ target: { kind: 'xpath' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"target.kind" must be one of/);
  });

  it('rejects semantic target without text', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ target: { kind: 'semantic' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/target.kind=semantic requires "target.text"/);
  });

  it('rejects element_id target without element_id', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ target: { kind: 'element_id' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/target.kind=element_id requires "target.element_id"/);
  });

  it('rejects selector target without selector', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ target: { kind: 'selector' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/target.kind=selector requires "target.selector"/);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('browser_screenshot handler — happy path', () => {
  let provider: BrowserProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('returns JSON screenshot result', async () => {
    const result = makeScreenshotResult({ bytes: 99000, width: 1920, height: 1080 });
    vi.mocked(provider.screenshot).mockResolvedValue(result);

    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler({}, makeSignal());

    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content as string) as ScreenshotResult;
    expect(parsed.bytes).toBe(99000);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
  });

  it('passes fullPage through to provider.screenshot', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ full_page: true }, makeSignal());

    expect(provider.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true }),
    );
  });

  it('passes semantic target through', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ target: { kind: 'semantic', text: 'Hero image' } }, makeSignal());

    expect(provider.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'semantic', text: 'Hero image' },
      }),
    );
  });

  it('passes element_id target through', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ target: { kind: 'element_id', element_id: 'el_xyz789' } }, makeSignal());

    expect(provider.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'element_id', elementId: 'el_xyz789' },
      }),
    );
  });

  it('includes sessionId in the screenshot call', async () => {
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({}, makeSignal());
    expect(provider.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

describe('browser_screenshot handler — provider errors', () => {
  it('returns isError when provider.screenshot throws', async () => {
    const provider = makeProvider({ screenshot: vi.fn().mockRejectedValue(new Error('no page')) });
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no page/);
  });

  it('returns playwright install hint on ERR_MODULE_NOT_FOUND', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('ERR_MODULE_NOT_FOUND playwright'));
    const handler = createBrowserScreenshotHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pnpm add playwright/);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe('browser_screenshot handler — abort signal', () => {
  it('returns immediately when signal is pre-aborted', async () => {
    const getBrowserProvider = vi.fn();
    const handler = createBrowserScreenshotHandler({ getBrowserProvider });

    const r = await handler({}, makeSignal(true));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/aborted/);
    expect(getBrowserProvider).not.toHaveBeenCalled();
  });
});
