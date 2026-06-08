/**
 * Playwright-backed browser launcher.
 *
 * Wraps a single Playwright `Browser` instance and a `Map` of session-scoped
 * `BrowserContext`s. The design enforces the lifecycle contract from
 * `src/browser/provider.ts`:
 *
 *   – ONE Browser per AFK process (created lazily on first `ensureBrowser`).
 *   – N BrowserContexts, one per `AgentSession`, keyed by `sessionId`.
 *   – ONE Page per context (the "single-tab" invariant of Phase 1).
 *
 * @module browser/playwright/launcher
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Dialog, Page, Request, Response } from 'playwright';
import type { BrowserConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

// In bundled (esbuild) builds, `__AFK_VERSION__` is replaced at compile time
// via esbuild's `define` option (see scripts/build-dist.mjs). Declared here so
// tsc accepts the reference; it is undefined in dev/tsx/vitest runs.
declare const __AFK_VERSION__: string | undefined;

// Contract: resolve once at module load time. Falls back to 'unknown' without
// crashing the process.
function resolveAFKVersion(): string {
  // Build-time injected literal — the source of truth in the published binary,
  // where this module is bundled into dist/cli.mjs and import.meta.dirname
  // points at dist/, so the relative package.json walk below would miss.
  try {
    if (typeof __AFK_VERSION__ === 'string' && __AFK_VERSION__.length > 0) {
      return __AFK_VERSION__;
    }
  } catch {
    // ReferenceError where the define wasn't applied (dev/tsx) — fall through.
  }

  // Dev fallback (tsx / vitest): import.meta.dirname is the real source dir,
  // and the package.json is three directories above src/browser/playwright/.
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed['version'] === 'string' ? parsed['version'] : 'unknown';
  } catch {
    return 'unknown';
  }
}

const AFK_VERSION: string = resolveAFKVersion();

// ---------------------------------------------------------------------------
// Internal per-session state
// ---------------------------------------------------------------------------

interface SessionEntry {
  context: BrowserContext;
  page: Page | undefined;
  consoleErrors: number;
  lastHttpStatus: number | null;
  openDialog: Dialog | undefined;
}

// ---------------------------------------------------------------------------
// BrowserLauncher
// ---------------------------------------------------------------------------

/**
 * Wraps a Playwright Browser + a map of session-scoped BrowserContexts.
 * One instance per AFK process — created lazily by `registry.ts`.
 *
 * Invariant: `this.browser` is either undefined (not yet launched / after
 * shutdown) or a connected `Browser` object. Any code path that reads
 * `this.browser` without going through `ensureBrowser()` MUST check
 * `isBrowserActive()` first.
 */
export class BrowserLauncher {
  private readonly config: BrowserConfig;

  // Undefined until first `ensureBrowser()` call, or after `shutdown()`.
  private browser: Browser | undefined;

  // Per-session state. Map.get() returns `SessionEntry | undefined` under
  // noUncheckedIndexedAccess — all callsites guard the return value.
  private readonly sessions = new Map<string, SessionEntry>();

  // Guards against concurrent `ensureBrowser` calls racing to launch a
  // second browser process.
  private launchPromise: Promise<Browser> | undefined;

  // Set to true by `shutdown()` so a second call no-ops cleanly.
  private shutdownComplete = false;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Browser lifecycle
  // -------------------------------------------------------------------------

  /**
   * Launch the browser if not already launched. Idempotent.
   *
   * Invariant: concurrent callers share a single in-flight launch promise so
   * at most one `chromium.launch` call is active at any time.
   *
   * Crash recovery: if `browser.isConnected()` returns false (the browser
   * process died since last launch), the stale reference is cleared and the
   * browser is re-launched. Existing sessions are NOT automatically
   * reconnected — callers must call `closeSession(sid)` before the next
   * `ensureContext(sid)` to get a fresh context on the new browser process.
   *
   * Throws on launch failure (e.g. Playwright not installed, out of memory).
   * The error propagates unchanged so callers can surface it as a
   * `ToolResult { isError: true }`.
   */
  async ensureBrowser(): Promise<Browser> {
    // Fast path: already connected.
    if (this.browser !== undefined && this.browser.isConnected()) {
      return this.browser;
    }

    // Crash-recovery path: reference exists but the process is gone. Clear it
    // so the launch below starts with a clean slate. Existing SessionEntry
    // objects in `this.sessions` are now dangling — callers must close them
    // before creating new pages on the fresh browser.
    if (this.browser !== undefined && !this.browser.isConnected()) {
      this.browser = undefined;
      this.launchPromise = undefined;
    }

    // Coalesce concurrent callers onto a single promise.
    if (this.launchPromise !== undefined) {
      return this.launchPromise;
    }

    this.launchPromise = chromium
      .launch({ headless: this.config.headless })
      .then((b) => {
        this.browser = b;
        this.launchPromise = undefined;
        return b;
      })
      .catch((err: unknown) => {
        this.launchPromise = undefined;
        throw err;
      });

    return this.launchPromise;
  }

  /**
   * True iff `ensureBrowser` has run and the underlying process is still
   * alive.
   */
  isBrowserActive(): boolean {
    return this.browser !== undefined && this.browser.isConnected();
  }

  // -------------------------------------------------------------------------
  // Context / Page lifecycle
  // -------------------------------------------------------------------------

  /**
   * Get (or lazily create) the BrowserContext for a session.
   *
   * Contract: returns the cached context for `sessionId` if one exists and
   * the browser is still connected. Creates a fresh context via
   * `browser.newContext()` on the first call for a session. The context is
   * configured with a 1280×800 viewport and a `userAgent` string that
   * includes `agent-afk/<version>` for observability.
   */
  async ensureContext(sessionId: string): Promise<BrowserContext> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      return existing.context;
    }

    const browser = await this.ensureBrowser();

    const context = await browser.newContext(this.contextOptions());

    const entry: SessionEntry = {
      context,
      page: undefined,
      consoleErrors: 0,
      lastHttpStatus: null,
      openDialog: undefined,
    };

    this.sessions.set(sessionId, entry);
    return context;
  }

  /**
   * Get (or lazily create) the single Page for a session.
   *
   * Contract: at most one Page exists per session (Phase 1 single-tab
   * invariant). On creation the following event listeners are installed:
   *
   *   • `console` — increments `consoleErrors` counter on `type() === 'error'`.
   *
   *   • `response` — tracks the HTTP status of the most recent main-frame
   *     navigation response. Heuristic: we match
   *     `resp.frame() === page.mainFrame()` AND
   *     `resp.request().isNavigationRequest()`. This is accurate for standard
   *     HTTP redirects; meta-refresh and history-push navigations that do not
   *     issue a network response will not update the status.
   *
   *   • `request` — resets `lastHttpStatus` to null whenever a new navigation
   *     request begins on the main frame, preventing stale codes from the
   *     previous page from being reported after a fresh navigation starts.
   *
   *   • `dialog` — captures the Dialog object so `hasOpenDialog` and
   *     `dismissDialog` can operate on it.
   */
  async ensurePage(sessionId: string): Promise<Page> {
    const existingEntry = this.sessions.get(sessionId);
    if (existingEntry !== undefined && existingEntry.page !== undefined) {
      return existingEntry.page;
    }

    // ensureContext creates the SessionEntry if absent.
    await this.ensureContext(sessionId);

    const liveEntry = this.sessions.get(sessionId);
    if (liveEntry === undefined) {
      throw new Error(
        `[BrowserLauncher] session entry disappeared for sessionId=${sessionId}`,
      );
    }

    // Another concurrent call may have already created the page.
    if (liveEntry.page !== undefined) {
      return liveEntry.page;
    }

    const page = await liveEntry.context.newPage();
    liveEntry.page = page;

    // Install console-error counter.
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        liveEntry.consoleErrors += 1;
      }
    });

    // Install navigation-request reset listener.
    // Invariant: reset lastHttpStatus to null at the start of each main-frame
    // navigation so callers never see a status code from a prior page.
    page.on('request', (req: Request) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        liveEntry.lastHttpStatus = null;
      }
    });

    // Install HTTP-status tracker.
    page.on('response', (resp: Response) => {
      if (
        resp.frame() === page.mainFrame() &&
        resp.request().isNavigationRequest()
      ) {
        liveEntry.lastHttpStatus = resp.status();
      }
    });

    // Install dialog tracker.
    page.on('dialog', (dialog: Dialog) => {
      liveEntry.openDialog = dialog;
    });

    return page;
  }

  /**
   * Returns the existing Page for a session if one has been created,
   * `undefined` otherwise. Does NOT create a new Page.
   */
  getPage(sessionId: string): Page | undefined {
    return this.sessions.get(sessionId)?.page;
  }

  // -------------------------------------------------------------------------
  // One-shot render (stateless content fetch)
  // -------------------------------------------------------------------------

  /**
   * Navigate an EPHEMERAL context to `url`, return the serialized post-load
   * DOM, and always tear the context down.
   *
   * Invariant: the context created here is NOT stored in `this.sessions`. It
   * has no sessionId, never collides with an interactive tab, and each call
   * owns its own context — so concurrent `web_scrape` renders are safe.
   *
   * Ordered teardown: the `finally` block closes the context unconditionally
   * (page closes with it). An abort closes the context early, which rejects
   * the in-flight `goto`/`content` with a "context closed" error the caller
   * maps to an abort. The abort listener is removed before the close so we
   * never leak a reference to the caller's signal.
   */
  async renderHtml(
    url: string,
    opts: {
      timeoutMs: number;
      waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
      signal?: AbortSignal;
    },
  ): Promise<{ html: string; finalUrl: string; httpStatus: number | null }> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext(this.contextOptions());

    const onAbort = (): void => {
      void context.close().catch(() => {
        // Best-effort — context may already be closing.
      });
    };

    // Pre-aborted short-circuit: tear down and reject before any navigation.
    if (opts.signal?.aborted === true) {
      await context.close().catch(() => { /* best-effort */ });
      throw new Error('render aborted');
    }
    if (opts.signal !== undefined) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const page = await context.newPage();
      const resp = await page.goto(url, {
        timeout: opts.timeoutMs,
        waitUntil: opts.waitUntil,
      });
      const html = await page.content();
      const finalUrl = page.url();
      const httpStatus = resp !== null ? resp.status() : null;
      return { html, finalUrl, httpStatus };
    } finally {
      if (opts.signal !== undefined) {
        opts.signal.removeEventListener('abort', onAbort);
      }
      await context.close().catch(() => {
        // Best-effort — context may already be closed (abort / crash).
      });
    }
  }

  // -------------------------------------------------------------------------
  // Instrumentation accessors
  // -------------------------------------------------------------------------

  /**
   * Console-error count for a session since its Page was created.
   * Returns 0 when no page exists for the session.
   */
  getConsoleErrorCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.consoleErrors ?? 0;
  }

  /**
   * Last navigation HTTP status for the session's page, or `null`.
   *
   * Updated by the `response` listener installed in `ensurePage`. Resets to
   * null on each new main-frame navigation request. Returns `null` when no
   * page exists, or when the navigation did not produce an HTTP response
   * (e.g. `javascript:` URIs, `about:blank`, history.pushState).
   */
  getLastHttpStatus(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.lastHttpStatus ?? null;
  }

  /**
   * True iff the page currently has an open alert / confirm / prompt dialog.
   * Cleared when the dialog is dismissed via `dismissDialog`.
   */
  hasOpenDialog(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.openDialog !== undefined;
  }

  /**
   * Dismiss or accept the open dialog for a session.
   *
   * Contract:
   *   - `accept = true` (default) → calls `dialog.accept()`.
   *   - `accept = false` → calls `dialog.dismiss()`.
   *   - Clears the tracked dialog before the async call so re-entrant checks
   *     see no dialog immediately.
   *   - No-op when no dialog is open for the session.
   *
   * Throws if the underlying Playwright accept/dismiss call throws (e.g.
   * dialog already auto-dismissed by page navigation).
   */
  async dismissDialog(sessionId: string, accept = true): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.openDialog === undefined) {
      return;
    }

    const dialog = entry.openDialog;
    // Clear before the async call: ordered write-before-side-effect so that
    // any re-entrant `hasOpenDialog` check (e.g. from a response listener)
    // sees the dialog as gone before we yield.
    entry.openDialog = undefined;

    if (accept) {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
  }

  // -------------------------------------------------------------------------
  // Session teardown
  // -------------------------------------------------------------------------

  /**
   * Close one session's context (and its page). Idempotent — does not throw
   * if the session is not found.
   *
   * Invariant: the browser process itself is left alive so other sessions
   * remain unaffected.
   *
   * Ordered teardown (page close → context close) ensures Playwright
   * finalizes page-level event listeners before freeing the context.
   */
  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      return;
    }

    // Remove from map first so concurrent callers see the session as gone
    // before we start tearing it down.
    this.sessions.delete(sessionId);

    if (entry.page !== undefined) {
      await entry.page.close().catch(() => {
        // Swallow — page may already be closed if the browser crashed.
      });
    }

    await entry.context.close().catch(() => {
      // Swallow — context may already be closed.
    });
  }

  /**
   * Close all sessions and the browser process. Idempotent — second call
   * no-ops.
   *
   * Invariant: sessions are closed before `browser.close()`. The reverse
   * order would leave dangling context handles and trigger Playwright
   * "context closed" errors inside the close calls.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownComplete) {
      return;
    }
    // Mark complete before async teardown so concurrent shutdown() calls
    // return immediately rather than racing.
    this.shutdownComplete = true;

    // Close all sessions in parallel.
    const sessionIds = [...this.sessions.keys()];
    await Promise.all(sessionIds.map((id) => this.closeSession(id)));

    if (this.browser !== undefined) {
      const browser = this.browser;
      this.browser = undefined;
      await browser.close().catch(() => {
        // Swallow — browser may already be closed (e.g. crash).
      });
    }
  }

  /**
   * Number of currently-open sessions.
   */
  activeSessions(): number {
    return this.sessions.size;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Shared `newContext()` options for both session contexts and one-shot
   * renders. Single source of truth for viewport + user-agent so the two
   * paths can't drift.
   */
  private contextOptions(): { viewport: { width: number; height: number }; userAgent: string } {
    return {
      viewport: { width: 1280, height: 800 },
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 agent-afk/${AFK_VERSION}`,
    };
  }
}
