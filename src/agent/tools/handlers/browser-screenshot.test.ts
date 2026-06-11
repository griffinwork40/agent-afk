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
    // 1x1 transparent PNG — realistic base64 the provider would return.
    dataBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    mediaType: 'image/png',
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

  it('returns JSON screenshot metadata with no base64 in the text content', async () => {
    const result = makeScreenshotResult({ bytes: 99000, width: 1920, height: 1080 });
    vi.mocked(provider.screenshot).mockResolvedValue(result);

    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler({}, makeSignal());

    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content as string) as ScreenshotResult;
    expect(parsed.bytes).toBe(99000);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
    // The base64 payload + its key must NEVER appear in the text the model
    // reads — it rides on the `image` field instead.
    expect(r.content).not.toContain('dataBase64');
    expect(r.content).not.toContain(result.dataBase64);
  });

  it('surfaces the screenshot as a model-visible image block', async () => {
    const result = makeScreenshotResult({ dataBase64: 'QUJDREVG', mediaType: 'image/png' });
    vi.mocked(provider.screenshot).mockResolvedValue(result);

    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler({}, makeSignal());

    expect(r.isError).toBeUndefined();
    // Pixels ride on the `image` field; the anthropic-direct loop emits it as
    // an image content block alongside the text metadata.
    expect(r.image).toEqual({ mediaType: 'image/png', data: 'QUJDREVG' });
    expect(r.content).not.toContain('QUJDREVG');
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
// Dimension guard (Anthropic 8000px vision limit)
// ---------------------------------------------------------------------------

describe('browser_screenshot handler — dimension guard', () => {
  it('drops the image (text-only) when height exceeds 8000px, without erroring', async () => {
    // A tall full_page screenshot: well under the 5 MiB byte cap, but its
    // pixel height blows past Anthropic's 8000px limit — attaching it would
    // 400 the request and poison message history.
    const result = makeScreenshotResult({ width: 1280, height: 20000, dataBase64: 'QUJDREVG' });
    const provider = makeProvider({ screenshot: vi.fn().mockResolvedValue(result) });
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ full_page: true }, makeSignal());

    // Graceful text-only degradation — NOT an error.
    expect(r.isError).toBeUndefined();
    expect(r.image).toBeUndefined();
    // The model still gets dimensions + a legible reason, and never the base64.
    const parsed = JSON.parse(r.content as string) as { width: number; height: number; imageOmitted?: string };
    expect(parsed.width).toBe(1280);
    expect(parsed.height).toBe(20000);
    expect(parsed.imageOmitted).toMatch(/8000px model-vision limit/);
    expect(r.content).not.toContain('QUJDREVG');
  });

  it('drops the image when width exceeds 8000px', async () => {
    const result = makeScreenshotResult({ width: 9000, height: 800 });
    const provider = makeProvider({ screenshot: vi.fn().mockResolvedValue(result) });
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({}, makeSignal());

    expect(r.isError).toBeUndefined();
    expect(r.image).toBeUndefined();
  });

  it('attaches the image at exactly 8000x8000 (boundary is inclusive)', async () => {
    const result = makeScreenshotResult({ width: 8000, height: 8000, dataBase64: 'QUJDREVG' });
    const provider = makeProvider({ screenshot: vi.fn().mockResolvedValue(result) });
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ full_page: true }, makeSignal());

    expect(r.isError).toBeUndefined();
    expect(r.image).toEqual({ mediaType: 'image/png', data: 'QUJDREVG' });
  });

  it('drops the image one pixel over the limit (8001px)', async () => {
    const result = makeScreenshotResult({ width: 8001, height: 800 });
    const provider = makeProvider({ screenshot: vi.fn().mockResolvedValue(result) });
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ full_page: true }, makeSignal());

    expect(r.isError).toBeUndefined();
    expect(r.image).toBeUndefined();
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
