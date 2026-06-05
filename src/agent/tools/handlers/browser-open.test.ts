/**
 * Tests for the `browser_open` tool handler.
 *
 * The browser registry (`src/browser/registry.ts`) is not yet available on
 * disk (authored by a sibling Wave B1 node). All tests use the
 * `getBrowserProvider` factory override so no real browser is launched and
 * no real registry is imported.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBrowserOpenHandler } from './browser-open.js';
import type { BrowserProvider } from '../../../browser/provider.js';
import type {
  BrowserObservation,
  BlockedByPolicy,
} from '../../../browser/types.js';

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
    observationId: 'obs_1',
    url: 'https://example.com',
    title: 'Example',
    textSummary: 'hello world',
    interactive: [],
    status: { httpStatus: 200, loadingState: 'idle', hasDialog: false, consoleErrors: 0 },
    warnings: [],
    screenshotPath: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBlockedByPolicy(reason = 'domain not in allowlist'): BlockedByPolicy {
  return { outcome: 'blocked_by_policy', url: 'https://example.com', reason };
}

function makeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    name: 'test',
    open: vi.fn().mockResolvedValue(makeObs()),
    observe: vi.fn(),
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

describe('browser_open handler — input validation', () => {
  const signal = makeSignal();

  it('rejects non-object input', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler('not-an-object' as unknown, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/must be an object/);
  });

  it('rejects missing url', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({}, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"url" is required/);
  });

  it('rejects non-string url', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ url: 42 }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"url" is required/);
  });

  it('rejects empty-string url', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ url: '' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"url" is required/);
  });

  it('rejects non-absolute URL', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ url: 'not-a-url' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a valid absolute URL/);
  });

  it('rejects non-http protocol', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ url: 'ftp://example.com' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not supported/);
  });

  it('rejects invalid wait_for value', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ url: 'https://example.com', wait_for: 'rendered' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"wait_for" must be one of/);
  });

  it('rejects non-boolean screenshot', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ url: 'https://example.com', screenshot: 'yes' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"screenshot" must be a boolean/);
  });

  it('rejects non-positive timeout_ms', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ url: 'https://example.com', timeout_ms: -500 }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"timeout_ms" must be a positive/);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('browser_open handler — happy path', () => {
  let provider: BrowserProvider;
  let getBrowserProvider: () => Promise<BrowserProvider>;

  beforeEach(() => {
    provider = makeProvider();
    getBrowserProvider = vi.fn().mockResolvedValue(provider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns JSON observation on success', async () => {
    const obs = makeObs({ url: 'https://example.com', title: 'Test Page' });
    vi.mocked(provider.open).mockResolvedValue(obs);

    const handler = createBrowserOpenHandler({ getBrowserProvider });
    const r = await handler({ url: 'https://example.com' }, makeSignal());

    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content as string) as BrowserObservation;
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.title).toBe('Test Page');
  });

  it('passes url, waitFor, screenshot, timeoutMs to provider.open', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider });
    await handler(
      { url: 'https://example.com', wait_for: 'networkidle', screenshot: true, timeout_ms: 5000 },
      makeSignal(),
    );

    expect(provider.open).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/',
        waitFor: 'networkidle',
        screenshot: true,
        timeoutMs: 5000,
      }),
    );
  });

  it('includes sessionId in the provider call', async () => {
    const handler = createBrowserOpenHandler({ getBrowserProvider });
    await handler({ url: 'https://example.com' }, makeSignal());
    expect(provider.open).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Blocked-by-policy
// ---------------------------------------------------------------------------

describe('browser_open handler — blocked_by_policy', () => {
  it('returns isError with blocked message when provider returns blocked outcome', async () => {
    const blocked = makeBlockedByPolicy('domain not allowed');
    const provider = makeProvider({ open: vi.fn().mockResolvedValue(blocked) });
    const getBrowserProvider = vi.fn().mockResolvedValue(provider);
    const handler = createBrowserOpenHandler({ getBrowserProvider });

    const r = await handler({ url: 'https://blocked.example.com' }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
    expect(r.content).toMatch(/domain not allowed/);
  });
});

// ---------------------------------------------------------------------------
// Provider error
// ---------------------------------------------------------------------------

describe('browser_open handler — provider errors', () => {
  it('returns isError when provider.open throws', async () => {
    const provider = makeProvider({ open: vi.fn().mockRejectedValue(new Error('browser crashed')) });
    const getBrowserProvider = vi.fn().mockResolvedValue(provider);
    const handler = createBrowserOpenHandler({ getBrowserProvider });

    const r = await handler({ url: 'https://example.com' }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/browser crashed/);
  });

  it('returns isError when getBrowserProvider throws', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('provider init failed'));
    const handler = createBrowserOpenHandler({ getBrowserProvider });

    const r = await handler({ url: 'https://example.com' }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/provider init failed/);
  });

  it('returns playwright install hint when error message contains ERR_MODULE_NOT_FOUND', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('ERR_MODULE_NOT_FOUND playwright'));
    const handler = createBrowserOpenHandler({ getBrowserProvider });

    const r = await handler({ url: 'https://example.com' }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pnpm add playwright/);
  });

  it('returns playwright install hint when error message contains Cannot find package', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('Cannot find package playwright'));
    const handler = createBrowserOpenHandler({ getBrowserProvider });

    const r = await handler({ url: 'https://example.com' }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pnpm add playwright/);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe('browser_open handler — abort signal', () => {
  it('returns immediately when signal is pre-aborted', async () => {
    const getBrowserProvider = vi.fn();
    const handler = createBrowserOpenHandler({ getBrowserProvider });

    const r = await handler({ url: 'https://example.com' }, makeSignal(true));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/aborted/);
    // Provider was never called
    expect(getBrowserProvider).not.toHaveBeenCalled();
  });
});
