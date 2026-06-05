/**
 * Unit tests for PlaywrightProvider (src/browser/playwright/index.ts).
 *
 * Strategy: mock `./launcher.js`, `./observe.js`, `./resolve-target.js`,
 * `../witness.js`, and `../config.js` via vitest vi.mock so no real browser
 * is spawned. Each test controls what the mocked modules return and asserts on
 * PlaywrightProvider's higher-level logic.
 *
 * NOTE: vi.mock is hoisted to the top of the file by vitest. Mocks that need
 * to reference per-test state use a module-scope `ctx` object so the factory
 * closures don't violate the hoisting constraint.
 *
 * We do NOT test Playwright's own correctness — those are covered in the Wave A
 * tests. Here we test PlaywrightProvider's orchestration of those dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserConfig, BrowserObservation, InteractiveElement } from '../types.js';

// ---------------------------------------------------------------------------
// Shared mutable context that hoisted mock factories can close over
// ---------------------------------------------------------------------------

const ctx = {
  page: null as Record<string, ReturnType<typeof vi.fn>> | null,
  locator: null as Record<string, ReturnType<typeof vi.fn>> | null,
  getPageFn: vi.fn() as ReturnType<typeof vi.fn>,
  ensurePageFn: vi.fn() as ReturnType<typeof vi.fn>,
  closeSessionFn: vi.fn() as ReturnType<typeof vi.fn>,
  shutdownFn: vi.fn() as ReturnType<typeof vi.fn>,
  getConsoleErrorCountFn: vi.fn() as ReturnType<typeof vi.fn>,
  getLastHttpStatusFn: vi.fn() as ReturnType<typeof vi.fn>,
  hasOpenDialogFn: vi.fn() as ReturnType<typeof vi.fn>,
};

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('./launcher.js', () => {
  function MockBrowserLauncher(_config: unknown) {
    return {
      ensurePage: (...args: unknown[]) => (ctx.ensurePageFn as (...a: unknown[]) => unknown)(...args),
      getPage: (...args: unknown[]) => (ctx.getPageFn as (...a: unknown[]) => unknown)(...args),
      closeSession: (...args: unknown[]) => (ctx.closeSessionFn as (...a: unknown[]) => unknown)(...args),
      shutdown: (...args: unknown[]) => (ctx.shutdownFn as (...a: unknown[]) => unknown)(...args),
      getConsoleErrorCount: (...args: unknown[]) =>
        (ctx.getConsoleErrorCountFn as (...a: unknown[]) => unknown)(...args),
      getLastHttpStatus: (...args: unknown[]) =>
        (ctx.getLastHttpStatusFn as (...a: unknown[]) => unknown)(...args),
      hasOpenDialog: (...args: unknown[]) =>
        (ctx.hasOpenDialogFn as (...a: unknown[]) => unknown)(...args),
    };
  }
  return { BrowserLauncher: MockBrowserLauncher };
});

vi.mock('./observe.js', () => ({
  observePage: vi.fn(),
}));

vi.mock('./resolve-target.js', () => ({
  resolveTarget: vi.fn(),
}));

vi.mock('../witness.js', () => ({
  writeScreenshotSidecar: vi.fn(),
  writeDomSnapshotSidecar: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadBrowserConfig: vi.fn().mockReturnValue({
    headless: true,
    allowedDomains: [],
    blockedDomains: [],
    domSnapshots: false,
    backend: 'playwright',
    configPath: null,
  }),
  enforceDomainPolicy: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import subjects AFTER mocks
// ---------------------------------------------------------------------------

import { PlaywrightProvider } from './index.js';
import { observePage } from './observe.js';
import { resolveTarget } from './resolve-target.js';
import { enforceDomainPolicy } from '../config.js';
import { writeScreenshotSidecar } from '../witness.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type MockFn = ReturnType<typeof vi.fn>;

function asMock(f: unknown): MockFn {
  return f as MockFn;
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeStubObservation(overrides: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    observationId: 'obs_1',
    url: 'https://example.com',
    title: 'Example',
    textSummary: 'Example page',
    interactive: [],
    status: { httpStatus: 200, loadingState: 'idle', hasDialog: false, consoleErrors: 0 },
    warnings: [],
    screenshotPath: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStubElement(id = 'el_abc123'): InteractiveElement {
  return {
    id,
    role: 'button',
    label: 'Submit',
    kind: null,
    value: null,
    state: { disabled: false },
    bbox: { x: 0, y: 0, w: 100, h: 40 },
  };
}

function makeStubPage(url = 'https://example.com'): Record<string, ReturnType<typeof vi.fn>> {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('PNG')),
    url: vi.fn().mockReturnValue(url),
    goBack: vi.fn().mockResolvedValue(undefined),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 800 }),
    evaluate: vi.fn().mockResolvedValue({ w: 1280, h: 6000 }),
  };
}

function makeStubLocator(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('PNG')),
  };
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const defaultConfig: BrowserConfig = {
  headless: true,
  allowedDomains: [],
  blockedDomains: [],
  domSnapshots: false,
  backend: 'playwright',
  configPath: null,
};

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

function resetCtx(): void {
  ctx.page = makeStubPage();
  ctx.locator = makeStubLocator();

  ctx.ensurePageFn = vi.fn().mockImplementation(() => Promise.resolve(ctx.page));
  ctx.getPageFn = vi.fn().mockImplementation(() => ctx.page);
  ctx.closeSessionFn = vi.fn().mockResolvedValue(undefined);
  ctx.shutdownFn = vi.fn().mockResolvedValue(undefined);
  ctx.getConsoleErrorCountFn = vi.fn().mockReturnValue(0);
  ctx.getLastHttpStatusFn = vi.fn().mockReturnValue(200);
  ctx.hasOpenDialogFn = vi.fn().mockReturnValue(false);
}

function makeProvider(): PlaywrightProvider {
  return new PlaywrightProvider(defaultConfig);
}

// ---------------------------------------------------------------------------
// Global beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetCtx();

  // Default behaviour for module-level mocks.
  asMock(observePage).mockResolvedValue(makeStubObservation());
  asMock(enforceDomainPolicy).mockReturnValue({ allowed: true });
  asMock(writeScreenshotSidecar).mockResolvedValue({ path: '/fake/screenshot.png', bytes: 100 });
  asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });
});

// ---------------------------------------------------------------------------
// open() tests
// ---------------------------------------------------------------------------

describe('open()', () => {
  it('returns BlockedByPolicy when domain is refused', async () => {
    asMock(enforceDomainPolicy).mockReturnValue({
      allowed: false,
      reason: 'blocked by AFK_BROWSER_BLOCKED_DOMAINS: evil.com',
    });

    const provider = makeProvider();
    const result = await provider.open({
      sessionId: 'sess1',
      url: 'https://evil.com',
    });

    expect(result).toMatchObject({
      outcome: 'blocked_by_policy',
      url: 'https://evil.com',
      reason: 'blocked by AFK_BROWSER_BLOCKED_DOMAINS: evil.com',
    });

    // ensurePage should NOT be called when the domain is blocked.
    expect(ctx.ensurePageFn).not.toHaveBeenCalled();
  });

  it('calls ensurePage and page.goto and returns the observation', async () => {
    const obs = makeStubObservation({ url: 'https://example.com', title: 'Test' });
    asMock(observePage).mockResolvedValue(obs);

    const provider = makeProvider();
    const result = await provider.open({
      sessionId: 'sess1',
      url: 'https://example.com',
    });

    expect(result).toBe(obs);
    expect(asMock(ctx.page?.['goto'])).toHaveBeenCalledWith('https://example.com', {
      timeout: 30000,
      waitUntil: 'load',
    });
  });

  it('uses custom timeoutMs and waitFor when provided', async () => {
    const provider = makeProvider();
    await provider.open({
      sessionId: 'sess1',
      url: 'https://example.com',
      timeoutMs: 5000,
      waitFor: 'networkidle',
    });

    expect(asMock(ctx.page?.['goto'])).toHaveBeenCalledWith('https://example.com', {
      timeout: 5000,
      waitUntil: 'networkidle',
    });
  });

  it('captures screenshot when screenshot:true is requested', async () => {
    const provider = makeProvider();
    await provider.open({
      sessionId: 'sess1',
      url: 'https://example.com',
      screenshot: true,
    });

    expect(asMock(ctx.page?.['screenshot'])).toHaveBeenCalled();
    expect(writeScreenshotSidecar).toHaveBeenCalledWith(
      'sess1',
      expect.any(Buffer),
      'browser_open',
    );
  });

  it('captures screenshot when navigation throws (then re-throws)', async () => {
    asMock(ctx.page?.['goto']).mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));

    const provider = makeProvider();
    await expect(
      provider.open({ sessionId: 'sess1', url: 'https://example.com' }),
    ).rejects.toThrow('net::ERR_CONNECTION_REFUSED');

    // Screenshot should have been captured before re-throw.
    expect(writeScreenshotSidecar).toHaveBeenCalledWith(
      'sess1',
      expect.any(Buffer),
      'browser_open',
    );
  });

  it('updates session state after open', async () => {
    const el = makeStubElement('el_001');
    const obs = makeStubObservation({
      url: 'https://example.com',
      title: 'Home',
      interactive: [el],
    });
    asMock(observePage).mockResolvedValue(obs);

    const provider = makeProvider();
    await provider.open({ sessionId: 'sess1', url: 'https://example.com' });

    const state = provider.describe('sess1');
    expect(state).toMatchObject({
      active: true,
      url: 'https://example.com',
      title: 'Home',
      lastAction: 'browser_open',
    });
    expect(state?.lastActionAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// observe() tests
// ---------------------------------------------------------------------------

describe('observe()', () => {
  it('throws when no page is open for the session', async () => {
    ctx.getPageFn = vi.fn().mockReturnValue(undefined);

    const provider = makeProvider();
    await expect(provider.observe({ sessionId: 'sess1' })).rejects.toThrow(
      'browser_observe: no page open for session sess1',
    );
  });

  it('returns the observation from observePage', async () => {
    const obs = makeStubObservation({ url: 'https://example.com' });
    asMock(observePage).mockResolvedValue(obs);

    const provider = makeProvider();
    const result = await provider.observe({ sessionId: 'sess1' });
    expect(result).toBe(obs);
  });

  it('captures screenshot when screenshot:true', async () => {
    const provider = makeProvider();
    await provider.observe({ sessionId: 'sess1', screenshot: true });

    expect(writeScreenshotSidecar).toHaveBeenCalledWith(
      'sess1',
      expect.any(Buffer),
      'browser_observe',
    );
  });
});

// ---------------------------------------------------------------------------
// act() tests
// ---------------------------------------------------------------------------

describe('act()', () => {
  it('throws when no page is open', async () => {
    ctx.getPageFn = vi.fn().mockReturnValue(undefined);

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'semantic', text: 'Submit' },
      }),
    ).rejects.toThrow('browser_act: no page open for session sess1');
  });

  it('throws when target is not found', async () => {
    asMock(resolveTarget).mockResolvedValue({
      outcome: 'not_found',
      query: { kind: 'semantic', text: 'NonExistent' },
    });

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'semantic', text: 'NonExistent' },
      }),
    ).rejects.toThrow("browser_act: target not found: semantic('NonExistent')");
  });

  it('returns AmbiguousTarget straight through from resolver', async () => {
    const el1 = makeStubElement('el_001');
    const el2 = makeStubElement('el_002');
    const ambiguous = {
      outcome: 'ambiguous_target' as const,
      query: { text: 'Submit' },
      candidates: [el1, el2],
    };
    asMock(resolveTarget).mockResolvedValue(ambiguous);

    const provider = makeProvider();
    const result = await provider.act({
      sessionId: 'sess1',
      action: 'click',
      target: { kind: 'semantic', text: 'Submit' },
    });

    expect(result).toBe(ambiguous);
    expect(result).toMatchObject({ outcome: 'ambiguous_target' });
  });

  it('calls locator.click() on click action', async () => {
    asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });

    const provider = makeProvider();
    await provider.act({
      sessionId: 'sess1',
      action: 'click',
      target: { kind: 'semantic', text: 'Submit' },
    });

    expect(asMock(ctx.locator?.['click'])).toHaveBeenCalledWith({ timeout: 30000 });
  });

  it('calls locator.fill() with raw value on fill action', async () => {
    asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });

    const provider = makeProvider();
    await provider.act({
      sessionId: 'sess1',
      action: 'fill',
      target: { kind: 'element_id', elementId: 'el_001' },
      value: 'hello@example.com',
    });

    expect(asMock(ctx.locator?.['fill'])).toHaveBeenCalledWith('hello@example.com');
  });

  it('retries once on net::ERR_FOO error then succeeds', async () => {
    const netErr = new Error('net::ERR_CONNECTION_RESET');
    asMock(ctx.locator?.['click'])
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(undefined);

    asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'semantic', text: 'Submit' },
      }),
    ).resolves.toBeDefined();

    expect(asMock(ctx.locator?.['click'])).toHaveBeenCalledTimes(2);
  });

  it('propagates error after retry if second attempt also fails', async () => {
    const netErr = new Error('net::ERR_CONNECTION_RESET');
    asMock(ctx.locator?.['click']).mockRejectedValue(netErr);

    asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'semantic', text: 'Submit' },
      }),
    ).rejects.toThrow('net::ERR_CONNECTION_RESET');

    expect(asMock(ctx.locator?.['click'])).toHaveBeenCalledTimes(2);
  });

  it('returns BlockedByPolicy when post-action navigation hit a refused domain', async () => {
    // Pre-action URL call returns example.com, post-action returns evil.com.
    asMock(ctx.page?.['url'])
      .mockReturnValueOnce('https://example.com')  // pre-action
      .mockReturnValue('https://evil.com');          // post-action (and any subsequent)

    // enforceDomainPolicy: allow for the (unused) pre-open check path,
    // block for the post-navigation check.
    asMock(enforceDomainPolicy)
      .mockReturnValueOnce({ allowed: false, reason: 'not in AFK_BROWSER_ALLOWED_DOMAINS' });

    asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });

    const provider = makeProvider();
    const result = await provider.act({
      sessionId: 'sess1',
      action: 'click',
      target: { kind: 'semantic', text: 'Go somewhere blocked' },
    });

    expect(result).toMatchObject({
      outcome: 'blocked_by_policy',
      url: 'https://evil.com',
      reason: 'not in AFK_BROWSER_ALLOWED_DOMAINS',
    });

    // goBack should have been called (best-effort).
    expect(asMock(ctx.page?.['goBack'])).toHaveBeenCalled();
  });

  it('captures screenshot when screenshot:true on act', async () => {
    asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });

    const provider = makeProvider();
    await provider.act({
      sessionId: 'sess1',
      action: 'click',
      target: { kind: 'semantic', text: 'Submit' },
      screenshot: true,
    });

    expect(writeScreenshotSidecar).toHaveBeenCalledWith(
      'sess1',
      expect.any(Buffer),
      'browser_act',
    );
  });

  it('updates session state after successful action', async () => {
    const el = makeStubElement('el_001');
    const obs = makeStubObservation({
      url: 'https://example.com',
      title: 'After',
      interactive: [el],
    });
    asMock(observePage).mockResolvedValue(obs);
    asMock(resolveTarget).mockResolvedValue({ outcome: 'resolved', locator: ctx.locator });

    const provider = makeProvider();
    await provider.act({
      sessionId: 'sess1',
      action: 'click',
      target: { kind: 'semantic', text: 'Submit' },
    });

    const state = provider.describe('sess1');
    expect(state?.lastAction).toBe('browser_act:click');
    expect(state?.url).toBe('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// describe() tests
// ---------------------------------------------------------------------------

describe('describe()', () => {
  it('returns null for an unknown session', () => {
    const provider = makeProvider();
    expect(provider.describe('unknown-session')).toBeNull();
  });

  it('returns populated state after open()', async () => {
    const obs = makeStubObservation({
      url: 'https://example.com',
      title: 'Home',
      interactive: [],
    });
    asMock(observePage).mockResolvedValue(obs);

    const provider = makeProvider();
    await provider.open({ sessionId: 'sess1', url: 'https://example.com' });

    const state = provider.describe('sess1');
    expect(state).not.toBeNull();
    expect(state?.active).toBe(true);
    expect(state?.url).toBe('https://example.com');
    expect(state?.title).toBe('Home');
    expect(state?.lastAction).toBe('browser_open');
    expect(state?.openTabs).toBe(1);
  });

  it('returns active:false when getPage returns undefined for session', async () => {
    // Set up so that after open() (which uses ensurePage), a subsequent
    // getPage() call for describe() returns undefined.
    let pageCallCount = 0;
    ctx.getPageFn = vi.fn().mockImplementation(() => {
      pageCallCount += 1;
      // Return the page on the first call (from act/observe, not open which
      // uses ensurePage), undefined on subsequent calls.
      if (pageCallCount === 1) return undefined;
      return undefined;
    });

    // We need to manually inject session state via open, but open uses
    // ensurePage. Use act() approach instead — manually call open then
    // override getPage after.
    const provider = makeProvider();
    await provider.open({ sessionId: 'sess1', url: 'https://example.com' });

    // Override getPage to return undefined AFTER open has seeded state.
    ctx.getPageFn = vi.fn().mockReturnValue(undefined);

    const state = provider.describe('sess1');
    // State exists (from the open call) but active is false.
    expect(state).not.toBeNull();
    expect(state?.active).toBe(false);
    expect(state?.openTabs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extract() tests
// ---------------------------------------------------------------------------

describe('extract()', () => {
  it('throws Error with Phase 1 not-implemented message', async () => {
    const provider = makeProvider();
    await expect(
      provider.extract({
        sessionId: 'sess1',
        schema: { type: 'object' },
      }),
    ).rejects.toThrow('browser_extract not implemented in Phase 1');
  });
});

// ---------------------------------------------------------------------------
// close() tests
// ---------------------------------------------------------------------------

describe('close()', () => {
  it('calls launcher.closeSession and removes session state', async () => {
    const obs = makeStubObservation();
    asMock(observePage).mockResolvedValue(obs);

    const provider = makeProvider();
    await provider.open({ sessionId: 'sess1', url: 'https://example.com' });

    expect(provider.describe('sess1')).not.toBeNull();

    await provider.close({ sessionId: 'sess1' });

    // Session state should be gone.
    expect(provider.describe('sess1')).toBeNull();
  });

  it('delegates to launcher.closeSession', async () => {
    const provider = makeProvider();
    await provider.open({ sessionId: 'sess1', url: 'https://example.com' });
    await provider.close({ sessionId: 'sess1' });
    expect(ctx.closeSessionFn).toHaveBeenCalledWith('sess1');
  });

  it('is idempotent when called twice', async () => {
    const provider = makeProvider();
    await provider.open({ sessionId: 'sess1', url: 'https://example.com' });
    await provider.close({ sessionId: 'sess1' });
    await expect(provider.close({ sessionId: 'sess1' })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shutdown() tests
// ---------------------------------------------------------------------------

describe('shutdown()', () => {
  it('clears all session state and calls launcher.shutdown()', async () => {
    const provider = makeProvider();
    await provider.open({ sessionId: 'sess1', url: 'https://example.com' });
    await provider.open({ sessionId: 'sess2', url: 'https://other.com' });

    expect(provider.describe('sess1')).not.toBeNull();
    expect(provider.describe('sess2')).not.toBeNull();

    await provider.shutdown();

    expect(provider.describe('sess1')).toBeNull();
    expect(provider.describe('sess2')).toBeNull();
    expect(ctx.shutdownFn).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — second shutdown is safe', async () => {
    const provider = makeProvider();
    await provider.shutdown();
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// describeTarget (via thrown error messages)
// ---------------------------------------------------------------------------

describe('describeTarget (via thrown error messages)', () => {
  it('formats semantic target in error', async () => {
    asMock(resolveTarget).mockResolvedValue({
      outcome: 'not_found',
      query: { kind: 'semantic', text: 'Sign in' },
    });

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'semantic', text: 'Sign in' },
      }),
    ).rejects.toThrow("semantic('Sign in')");
  });

  it('formats semantic target with role in error', async () => {
    asMock(resolveTarget).mockResolvedValue({
      outcome: 'not_found',
      query: { kind: 'semantic', text: 'Sign in', role: 'button' },
    });

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'semantic', text: 'Sign in', role: 'button' },
      }),
    ).rejects.toThrow("semantic('Sign in', role='button')");
  });

  it('formats element_id target in error', async () => {
    asMock(resolveTarget).mockResolvedValue({
      outcome: 'not_found',
      query: { kind: 'element_id', elementId: 'el_abc123' },
    });

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'element_id', elementId: 'el_abc123' },
      }),
    ).rejects.toThrow('element_id(el_abc123)');
  });

  it('formats selector target in error', async () => {
    asMock(resolveTarget).mockResolvedValue({
      outcome: 'not_found',
      query: { kind: 'selector', selector: '#submit' },
    });

    const provider = makeProvider();
    await expect(
      provider.act({
        sessionId: 'sess1',
        action: 'click',
        target: { kind: 'selector', selector: '#submit' },
      }),
    ).rejects.toThrow('selector(#submit)');
  });
});
