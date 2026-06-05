/**
 * Unit tests for BrowserLauncher.
 *
 * Strategy: mock the `playwright` module via vitest's `vi.mock` so that
 * `chromium.launch` returns a stub Browser. No real Chromium process is
 * spawned. The stubs are minimal — they expose only the surface that
 * BrowserLauncher actually calls.
 *
 * vi.mock is hoisted to module scope by vitest, so the mock is in place
 * before launcher.ts is imported.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

interface StubPage {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  mainFrame: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  _consoleListeners: Array<(msg: { type: () => string }) => void>;
  _requestListeners: Array<(req: { isNavigationRequest: () => boolean; frame: () => object }) => void>;
  _responseListeners: Array<(resp: { frame: () => object; request: () => { isNavigationRequest: () => boolean }; status: () => number }) => void>;
  _dialogListeners: Array<(dialog: object) => void>;
}

interface StubContext {
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _pages: StubPage[];
}

interface StubBrowser {
  newContext: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  _contexts: StubContext[];
}

// ---------------------------------------------------------------------------
// Factory helpers — create fresh stubs per-test
// ---------------------------------------------------------------------------

function makeStubPage(): StubPage {
  const page: StubPage = {
    close: vi.fn().mockResolvedValue(undefined),
    // `on` captures listeners so tests can fire them manually
    on: vi.fn(),
    mainFrame: vi.fn(),
    url: vi.fn().mockReturnValue('about:blank'),
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    content: vi.fn().mockResolvedValue('<html><body>stub</body></html>'),
    _consoleListeners: [],
    _requestListeners: [],
    _responseListeners: [],
    _dialogListeners: [],
  };

  // Wire up mainFrame to return a sentinel object so frame() comparisons work.
  const mainFrameObj = {};
  page.mainFrame.mockReturnValue(mainFrameObj);

  page.on.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'console') {
      page._consoleListeners.push(listener as StubPage['_consoleListeners'][number]);
    } else if (event === 'request') {
      page._requestListeners.push(listener as StubPage['_requestListeners'][number]);
    } else if (event === 'response') {
      page._responseListeners.push(listener as StubPage['_responseListeners'][number]);
    } else if (event === 'dialog') {
      page._dialogListeners.push(listener as StubPage['_dialogListeners'][number]);
    }
  });

  return page;
}

function makeStubContext(): StubContext {
  const ctx: StubContext = {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn(),
    _pages: [],
  };
  ctx.newPage.mockImplementation(() => {
    const p = makeStubPage();
    ctx._pages.push(p);
    return Promise.resolve(p);
  });
  return ctx;
}

function makeStubBrowser(): StubBrowser {
  const b: StubBrowser = {
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    newContext: vi.fn(),
    _contexts: [],
  };
  b.newContext.mockImplementation(() => {
    const c = makeStubContext();
    b._contexts.push(c);
    return Promise.resolve(c);
  });
  return b;
}

// ---------------------------------------------------------------------------
// Mock playwright
//
// vi.mock is hoisted by vitest so the mock factory runs before any import.
// We store the "current" stub browser in a module-scope variable so individual
// tests can replace it (e.g. to simulate a disconnected browser).
// ---------------------------------------------------------------------------

let currentStubBrowser: StubBrowser = makeStubBrowser();

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => currentStubBrowser),
  },
}));

// Import AFTER the mock so the hoisted mock is in place.
import { BrowserLauncher } from './launcher.js';
import type { BrowserConfig } from '../types.js';
import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// Test config fixture
// ---------------------------------------------------------------------------

const TEST_CONFIG: BrowserConfig = {
  headless: true,
  allowedDomains: [],
  blockedDomains: [],
  domSnapshots: false,
  backend: 'playwright',
  configPath: null,
};

// ---------------------------------------------------------------------------
// Helper: fire console-error event on a page
// ---------------------------------------------------------------------------

function fireConsoleError(page: StubPage): void {
  for (const l of page._consoleListeners) {
    l({ type: () => 'error' });
  }
}

function fireConsoleWarn(page: StubPage): void {
  for (const l of page._consoleListeners) {
    l({ type: () => 'warn' });
  }
}

// ---------------------------------------------------------------------------
// Helper: fire response event on a page with given status
// ---------------------------------------------------------------------------

function fireResponse(page: StubPage, status: number): void {
  const mainFrame = page.mainFrame();
  for (const l of page._responseListeners) {
    l({
      frame: () => mainFrame,
      request: () => ({ isNavigationRequest: () => true }),
      status: () => status,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BrowserLauncher', () => {
  beforeEach(() => {
    // Reset the stub browser to a fresh connected instance before each test.
    currentStubBrowser = makeStubBrowser();
    // Reset the mock call history on chromium.launch.
    vi.mocked(chromium.launch).mockClear();
    vi.mocked(chromium.launch).mockImplementation(async () => currentStubBrowser);
  });

  // -------------------------------------------------------------------------
  // ensureBrowser
  // -------------------------------------------------------------------------

  describe('ensureBrowser', () => {
    it('launches exactly once on the first call', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const browser = await launcher.ensureBrowser();
      expect(browser).toBe(currentStubBrowser);
      expect(chromium.launch).toHaveBeenCalledTimes(1);
    });

    it('returns the same Browser on repeated calls (idempotent)', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const b1 = await launcher.ensureBrowser();
      const b2 = await launcher.ensureBrowser();
      const b3 = await launcher.ensureBrowser();
      expect(b1).toBe(b2);
      expect(b2).toBe(b3);
      expect(chromium.launch).toHaveBeenCalledTimes(1);
    });

    it('re-launches after the browser disconnects (crash recovery)', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);

      // First launch — browser is connected.
      await launcher.ensureBrowser();
      expect(chromium.launch).toHaveBeenCalledTimes(1);

      // Simulate crash: make isConnected() return false.
      currentStubBrowser.isConnected.mockReturnValue(false);

      // Prepare a fresh browser for the re-launch.
      const freshBrowser = makeStubBrowser();
      vi.mocked(chromium.launch).mockResolvedValueOnce(freshBrowser as unknown as Awaited<ReturnType<typeof chromium.launch>>);

      const b2 = await launcher.ensureBrowser();
      expect(chromium.launch).toHaveBeenCalledTimes(2);
      expect(b2).toBe(freshBrowser);
    });

    it('reflects the new browser in isBrowserActive after relaunch', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureBrowser();
      expect(launcher.isBrowserActive()).toBe(true);

      currentStubBrowser.isConnected.mockReturnValue(false);
      expect(launcher.isBrowserActive()).toBe(false);

      const freshBrowser = makeStubBrowser();
      vi.mocked(chromium.launch).mockResolvedValueOnce(freshBrowser as unknown as Awaited<ReturnType<typeof chromium.launch>>);
      await launcher.ensureBrowser();
      expect(launcher.isBrowserActive()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ensureContext
  // -------------------------------------------------------------------------

  describe('ensureContext', () => {
    it('creates a context on first call for a session', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const ctx = await launcher.ensureContext('session-A');
      expect(ctx).toBeDefined();
      expect(currentStubBrowser.newContext).toHaveBeenCalledTimes(1);
    });

    it('returns the cached context on repeated calls for the same session', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const ctx1 = await launcher.ensureContext('session-A');
      const ctx2 = await launcher.ensureContext('session-A');
      expect(ctx1).toBe(ctx2);
      expect(currentStubBrowser.newContext).toHaveBeenCalledTimes(1);
    });

    it('creates different contexts for different sessions', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const ctxA = await launcher.ensureContext('session-A');
      const ctxB = await launcher.ensureContext('session-B');
      expect(ctxA).not.toBe(ctxB);
      expect(currentStubBrowser.newContext).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // ensurePage / getPage
  // -------------------------------------------------------------------------

  describe('ensurePage', () => {
    it('creates a page and returns it', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const page = await launcher.ensurePage('session-A');
      expect(page).toBeDefined();
    });

    it('returns the same page on repeated calls (single-tab invariant)', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const p1 = await launcher.ensurePage('session-A');
      const p2 = await launcher.ensurePage('session-A');
      expect(p1).toBe(p2);
    });

    it('installs event listeners on the page', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const stub = currentStubBrowser._contexts[0]?._pages[0];
      expect(stub).toBeDefined();
      expect(stub!.on).toHaveBeenCalledWith('console', expect.any(Function));
      expect(stub!.on).toHaveBeenCalledWith('request', expect.any(Function));
      expect(stub!.on).toHaveBeenCalledWith('response', expect.any(Function));
      expect(stub!.on).toHaveBeenCalledWith('dialog', expect.any(Function));
    });
  });

  describe('renderHtml (one-shot ephemeral render)', () => {
    it('navigates, returns html/finalUrl/httpStatus, and tears down the context', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const ctx = makeStubContext();
      currentStubBrowser.newContext.mockResolvedValueOnce(ctx);
      ctx.newPage.mockImplementationOnce(async () => {
        const p = makeStubPage();
        p.goto.mockResolvedValueOnce({ status: () => 201 });
        p.content.mockResolvedValueOnce('<html><body>rendered</body></html>');
        p.url.mockReturnValue('https://example.com/final');
        ctx._pages.push(p);
        return p;
      });

      const out = await launcher.renderHtml('https://example.com/start', {
        timeoutMs: 5000,
        waitUntil: 'load',
      });

      expect(out.html).toBe('<html><body>rendered</body></html>');
      expect(out.finalUrl).toBe('https://example.com/final');
      expect(out.httpStatus).toBe(201);
      // Ephemeral context: closed, and NOT tracked as a session.
      expect(ctx.close).toHaveBeenCalledTimes(1);
      expect(launcher.activeSessions()).toBe(0);
    });

    it('closes the ephemeral context even when navigation throws', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const ctx = makeStubContext();
      currentStubBrowser.newContext.mockResolvedValueOnce(ctx);
      ctx.newPage.mockImplementationOnce(async () => {
        const p = makeStubPage();
        p.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
        ctx._pages.push(p);
        return p;
      });

      await expect(
        launcher.renderHtml('https://nope.invalid', { timeoutMs: 5000, waitUntil: 'load' }),
      ).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it('short-circuits a pre-aborted signal without navigating', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const ctx = makeStubContext();
      currentStubBrowser.newContext.mockResolvedValueOnce(ctx);
      const ac = new AbortController();
      ac.abort(new Error('cancelled'));

      await expect(
        launcher.renderHtml('https://example.com', {
          timeoutMs: 5000,
          waitUntil: 'load',
          signal: ac.signal,
        }),
      ).rejects.toThrow(/render aborted/);
      // No page was created; context torn down.
      expect(ctx.newPage).not.toHaveBeenCalled();
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPage', () => {
    it('returns undefined before ensurePage is called', () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      expect(launcher.getPage('session-A')).toBeUndefined();
    });

    it('returns the page after ensurePage is called', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const created = await launcher.ensurePage('session-A');
      expect(launcher.getPage('session-A')).toBe(created);
    });
  });

  // -------------------------------------------------------------------------
  // Session isolation
  // -------------------------------------------------------------------------

  describe('session isolation', () => {
    it('closing sessionA does not affect sessionB context', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureContext('session-A');
      const ctxB = await launcher.ensureContext('session-B');

      await launcher.closeSession('session-A');

      // sessionB context should still be retrievable and the same object
      const ctxB2 = await launcher.ensureContext('session-B');
      expect(ctxB2).toBe(ctxB);
    });

    it('closing sessionA does not affect sessionB page', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      const pageB = await launcher.ensurePage('session-B');
      await launcher.ensurePage('session-A');

      await launcher.closeSession('session-A');

      expect(launcher.getPage('session-B')).toBe(pageB);
    });

    it('activeSessions reflects the open session count', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      expect(launcher.activeSessions()).toBe(0);

      await launcher.ensureContext('session-A');
      expect(launcher.activeSessions()).toBe(1);

      await launcher.ensureContext('session-B');
      expect(launcher.activeSessions()).toBe(2);

      await launcher.closeSession('session-A');
      expect(launcher.activeSessions()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // closeSession
  // -------------------------------------------------------------------------

  describe('closeSession', () => {
    it('is idempotent — no throw on double close', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureContext('session-A');
      await expect(launcher.closeSession('session-A')).resolves.toBeUndefined();
      await expect(launcher.closeSession('session-A')).resolves.toBeUndefined();
    });

    it('is idempotent — no throw when session never existed', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await expect(launcher.closeSession('does-not-exist')).resolves.toBeUndefined();
    });

    it('closes the page before the context', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');

      const ctx = currentStubBrowser._contexts[0]!;
      const page = ctx._pages[0]!;

      const order: string[] = [];
      page.close.mockImplementation(async () => { order.push('page'); });
      ctx.close.mockImplementation(async () => { order.push('ctx'); });

      await launcher.closeSession('session-A');
      expect(order).toEqual(['page', 'ctx']);
    });

    it('removes the session from the map after close', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureContext('session-A');
      await launcher.closeSession('session-A');
      expect(launcher.activeSessions()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------

  describe('shutdown', () => {
    it('closes all sessions and the browser', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureContext('session-A');
      await launcher.ensureContext('session-B');

      await launcher.shutdown();

      expect(currentStubBrowser.close).toHaveBeenCalledTimes(1);
      expect(launcher.activeSessions()).toBe(0);
    });

    it('is idempotent — second call no-ops', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureBrowser();

      await launcher.shutdown();
      await launcher.shutdown();

      // browser.close should only have been called once
      expect(currentStubBrowser.close).toHaveBeenCalledTimes(1);
    });

    it('sets isBrowserActive to false after shutdown', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureBrowser();
      expect(launcher.isBrowserActive()).toBe(true);

      await launcher.shutdown();
      // After shutdown, browser reference is cleared
      expect(launcher.isBrowserActive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isBrowserActive
  // -------------------------------------------------------------------------

  describe('isBrowserActive', () => {
    it('returns false before ensureBrowser is called', () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      expect(launcher.isBrowserActive()).toBe(false);
    });

    it('returns true after ensureBrowser succeeds', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureBrowser();
      expect(launcher.isBrowserActive()).toBe(true);
    });

    it('returns false when isConnected() returns false', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensureBrowser();
      currentStubBrowser.isConnected.mockReturnValue(false);
      expect(launcher.isBrowserActive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getConsoleErrorCount
  // -------------------------------------------------------------------------

  describe('getConsoleErrorCount', () => {
    it('returns 0 before any page is created', () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      expect(launcher.getConsoleErrorCount('session-A')).toBe(0);
    });

    it('returns 0 when no console errors have fired', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      expect(launcher.getConsoleErrorCount('session-A')).toBe(0);
    });

    it('increments when a console error event fires', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      fireConsoleError(page);
      expect(launcher.getConsoleErrorCount('session-A')).toBe(1);

      fireConsoleError(page);
      fireConsoleError(page);
      expect(launcher.getConsoleErrorCount('session-A')).toBe(3);
    });

    it('does not increment for non-error console events', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      fireConsoleWarn(page);
      expect(launcher.getConsoleErrorCount('session-A')).toBe(0);
    });

    it('counts are isolated per session', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      await launcher.ensurePage('session-B');

      const pageA = currentStubBrowser._contexts[0]!._pages[0]!;
      fireConsoleError(pageA);
      fireConsoleError(pageA);

      expect(launcher.getConsoleErrorCount('session-A')).toBe(2);
      expect(launcher.getConsoleErrorCount('session-B')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getLastHttpStatus
  // -------------------------------------------------------------------------

  describe('getLastHttpStatus', () => {
    it('returns null before any page is created', () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      expect(launcher.getLastHttpStatus('session-A')).toBeNull();
    });

    it('returns null after page creation (no navigation yet)', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      expect(launcher.getLastHttpStatus('session-A')).toBeNull();
    });

    it('reflects the status from the response listener', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      fireResponse(page, 200);
      expect(launcher.getLastHttpStatus('session-A')).toBe(200);
    });

    it('updates to the latest status on each navigation', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      fireResponse(page, 200);
      expect(launcher.getLastHttpStatus('session-A')).toBe(200);

      fireResponse(page, 404);
      expect(launcher.getLastHttpStatus('session-A')).toBe(404);
    });

    it('resets to null when a navigation request starts', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      // First navigation gives status 200
      fireResponse(page, 200);
      expect(launcher.getLastHttpStatus('session-A')).toBe(200);

      // New navigation starts — should reset
      const mainFrame = page.mainFrame();
      for (const listener of page._requestListeners) {
        listener({
          isNavigationRequest: () => true,
          frame: () => mainFrame,
        });
      }
      expect(launcher.getLastHttpStatus('session-A')).toBeNull();
    });

    it('does not reset on non-navigation requests', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      fireResponse(page, 200);

      // Fire a non-navigation request (e.g. an XHR)
      const mainFrame = page.mainFrame();
      for (const listener of page._requestListeners) {
        listener({
          isNavigationRequest: () => false,
          frame: () => mainFrame,
        });
      }
      // Status should be unchanged
      expect(launcher.getLastHttpStatus('session-A')).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // hasOpenDialog / dismissDialog
  // -------------------------------------------------------------------------

  describe('hasOpenDialog / dismissDialog', () => {
    it('returns false when no dialog has fired', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      expect(launcher.hasOpenDialog('session-A')).toBe(false);
    });

    it('returns true after a dialog event fires', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      const fakeDialog = { accept: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined) };
      for (const l of page._dialogListeners) {
        l(fakeDialog);
      }

      expect(launcher.hasOpenDialog('session-A')).toBe(true);
    });

    it('dismissDialog with accept=true calls dialog.accept', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      const fakeDialog = { accept: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined) };
      for (const l of page._dialogListeners) l(fakeDialog);

      await launcher.dismissDialog('session-A', true);
      expect(fakeDialog.accept).toHaveBeenCalledTimes(1);
      expect(fakeDialog.dismiss).not.toHaveBeenCalled();
      expect(launcher.hasOpenDialog('session-A')).toBe(false);
    });

    it('dismissDialog with accept=false calls dialog.dismiss', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      const page = currentStubBrowser._contexts[0]!._pages[0]!;

      const fakeDialog = { accept: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined) };
      for (const l of page._dialogListeners) l(fakeDialog);

      await launcher.dismissDialog('session-A', false);
      expect(fakeDialog.dismiss).toHaveBeenCalledTimes(1);
      expect(fakeDialog.accept).not.toHaveBeenCalled();
      expect(launcher.hasOpenDialog('session-A')).toBe(false);
    });

    it('dismissDialog is a no-op when no dialog is open', async () => {
      const launcher = new BrowserLauncher(TEST_CONFIG);
      await launcher.ensurePage('session-A');
      await expect(launcher.dismissDialog('session-A', true)).resolves.toBeUndefined();
    });
  });
});
