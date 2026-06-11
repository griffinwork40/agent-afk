/**
 * Playwright-backed BrowserProvider implementation.
 *
 * Implements the `BrowserProvider` interface from `../provider.ts` using
 * Playwright's chromium backend via `BrowserLauncher`. This is the Phase 1
 * concrete backend — other backends (CdpProvider, etc.) may follow in Phase 4.
 *
 * @module browser/playwright/index
 */

import type { Page } from 'playwright';
import type { BrowserProvider, OpenOutcome, ActOutcome } from '../provider.js';
import type {
  ActInput,
  BrowserConfig,
  BrowserProviderState,
  CloseInput,
  ExtractInput,
  ExtractResult,
  InteractiveElement,
  ObserveInput,
  OpenInput,
  RenderInput,
  RenderResult,
  ScreenshotInput,
  ScreenshotResult,
  Target,
} from '../types.js';
import { BrowserLauncher } from './launcher.js';
import { observePage } from './observe.js';
import { resolveTarget } from './resolve-target.js';
import { enforceDomainPolicy } from '../config.js';
import { redactSecrets } from '../sanitize.js';
import { writeScreenshotSidecar } from '../witness.js';

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  observationCounter: number;
  knownElements: Map<string, InteractiveElement>;
  lastAction: string | null;
  lastActionAt: string | null;
  currentUrl: string | null;
  currentTitle: string | null;
}

// ---------------------------------------------------------------------------
// describeTarget helper
// ---------------------------------------------------------------------------

/**
 * Produce a short human-readable description of a Target for error messages.
 *
 * Contract: pure function, no I/O. Returns a string in one of these forms:
 *   - `semantic('Sign in')` for semantic targets
 *   - `element_id(el_abc123)` for element_id targets
 *   - `selector(#submit)` for selector targets
 */
function describeTarget(target: Target): string {
  switch (target.kind) {
    case 'semantic':
      return target.role !== undefined
        ? `semantic('${target.text}', role='${target.role}')`
        : `semantic('${target.text}')`;
    case 'element_id':
      return `element_id(${target.elementId})`;
    case 'selector':
      return `selector(${target.selector})`;
  }
}

// ---------------------------------------------------------------------------
// PlaywrightProvider
// ---------------------------------------------------------------------------

/**
 * Concrete BrowserProvider implementation backed by Playwright/chromium.
 *
 * Invariant: construction is synchronous and cheap — the BrowserLauncher is
 * created but `ensureBrowser()` is deliberately NOT called. The browser
 * process is launched lazily on the first `open()` call, so importing or
 * constructing this class does not spawn chromium.
 *
 * Invariant: one `PlaywrightProvider` instance manages ONE chromium process
 * (via BrowserLauncher) and N session-scoped BrowserContexts, one per
 * `sessionId`. The `sessions` map here mirrors BrowserLauncher's internal
 * map, but carries higher-level observation state (element lists, last action).
 */
export class PlaywrightProvider implements BrowserProvider {
  readonly name = 'playwright';

  private readonly config: BrowserConfig;
  private readonly launcher: BrowserLauncher;
  private readonly sessions = new Map<string, SessionState>();

  constructor(config: BrowserConfig) {
    this.config = config;
    // Contract: BrowserLauncher is constructed synchronously but the browser
    // process is not launched yet. ensureBrowser() runs lazily inside
    // ensurePage() on the first open() call.
    this.launcher = new BrowserLauncher(config);
  }

  // -------------------------------------------------------------------------
  // open()
  // -------------------------------------------------------------------------

  /**
   * Navigate to a URL in the session's tab and return a post-load observation.
   *
   * Invariant: domain policy is enforced BEFORE the page is created so that
   * blocked URLs never touch the browser process. The BrowserContext is
   * created lazily on first open() via ensurePage().
   */
  async open(input: OpenInput): Promise<OpenOutcome> {
    // Domain policy check before any browser interaction.
    const policyResult = enforceDomainPolicy(input.url, this.config);
    if (!policyResult.allowed) {
      return {
        outcome: 'blocked_by_policy',
        url: input.url,
        reason: policyResult.reason,
      };
    }

    const { sessionId } = input;
    const page = await this.launcher.ensurePage(sessionId);
    const state = this.ensureSessionState(sessionId);

    let screenshotPath: string | null = null;
    let navError: unknown = null;

    try {
      await page.goto(input.url, {
        timeout: input.timeoutMs ?? 30000,
        waitUntil: input.waitFor ?? 'load',
      });
    } catch (err) {
      navError = err;
    }

    // Capture screenshot if requested or if navigation threw.
    if (input.screenshot === true || navError !== null) {
      screenshotPath = await this.captureScreenshot(page, sessionId, 'browser_open');
    }

    // Build observation.
    state.observationCounter += 1;
    const obs = await observePage(page, {
      observationCounter: state.observationCounter,
      screenshotPath,
      consoleErrors: this.launcher.getConsoleErrorCount(sessionId),
      httpStatus: this.launcher.getLastHttpStatus(sessionId),
      hasDialog: this.launcher.hasOpenDialog(sessionId),
    });

    // Update session state.
    this.updateSessionFromObservation(state, obs.interactive, obs.url, obs.title, 'browser_open');

    // Re-throw navigation errors after capturing the observation.
    if (navError !== null) {
      throw navError;
    }

    return obs;
  }

  // -------------------------------------------------------------------------
  // observe()
  // -------------------------------------------------------------------------

  /**
   * Re-snapshot the current page without performing an action.
   *
   * Invariant: throws if no page is open for the session — calling observe()
   * before open() is a usage error, not a recoverable condition.
   */
  async observe(input: ObserveInput): Promise<import('../types.js').BrowserObservation> {
    const { sessionId } = input;
    const page = this.launcher.getPage(sessionId);
    if (page === undefined) {
      throw new Error(`browser_observe: no page open for session ${sessionId}`);
    }

    const state = this.ensureSessionState(sessionId);
    let screenshotPath: string | null = null;

    if (input.screenshot === true) {
      screenshotPath = await this.captureScreenshot(page, sessionId, 'browser_observe');
    }

    state.observationCounter += 1;
    const obs = await observePage(page, {
      observationCounter: state.observationCounter,
      screenshotPath,
      consoleErrors: this.launcher.getConsoleErrorCount(sessionId),
      httpStatus: this.launcher.getLastHttpStatus(sessionId),
      hasDialog: this.launcher.hasOpenDialog(sessionId),
      includeHidden: input.includeHidden,
      maxElements: input.maxElements,
    });

    this.updateSessionFromObservation(state, obs.interactive, obs.url, obs.title, 'browser_observe');

    return obs;
  }

  // -------------------------------------------------------------------------
  // act()
  // -------------------------------------------------------------------------

  /**
   * Perform an action against a target on the current page.
   *
   * Invariant: returns structured outcomes for expected conditions
   * (ambiguous_target, blocked_by_policy) rather than throwing. Only truly
   * unrecoverable failures (provider crash, element gone) are thrown.
   *
   * Invariant: post-action URL is checked against domain policy. If the
   * action triggered navigation to a blocked domain, we navigate back
   * (best-effort) and return BlockedByPolicy.
   */
  async act(input: ActInput): Promise<ActOutcome> {
    const { sessionId } = input;
    const page = this.launcher.getPage(sessionId);
    if (page === undefined) {
      throw new Error(`browser_act: no page open for session ${sessionId}`);
    }

    const state = this.ensureSessionState(sessionId);
    const preActionUrl = page.url();
    const timeout = input.timeoutMs ?? 30000;

    // Resolve the target to a locator.
    const resolution = await resolveTarget(page, input.target, state.knownElements);

    if (resolution.outcome === 'not_found') {
      throw new Error(`browser_act: target not found: ${describeTarget(input.target)}`);
    }

    if (resolution.outcome === 'ambiguous_target') {
      // Return the structured outcome directly — the handler maps to ToolResult.isError.
      return resolution;
    }

    // resolution.outcome === 'resolved'
    const { locator } = resolution;
    let actionError: unknown = null;

    // Execute the action with one retry on network/navigation errors.
    const executeAction = async (): Promise<void> => {
      switch (input.action) {
        case 'click':
          await locator.click({ timeout });
          break;
        case 'fill': {
          // Capture the redacted form for witness/logging; the raw value is
          // passed to locator.fill() so the actual form field receives the
          // intended content.
          const _redactedValue = redactSecrets(input.value ?? '');
          void _redactedValue; // suppress noUnusedLocals — ready for browser_event wiring
          await locator.fill(input.value ?? '');
          break;
        }
        case 'press':
          await locator.press(input.value ?? '');
          break;
        case 'select':
          await locator.selectOption(input.value ?? '');
          break;
        case 'hover':
          await locator.hover({ timeout });
          break;
        case 'scroll_to':
          await locator.scrollIntoViewIfNeeded({ timeout });
          break;
        case 'wait_for':
          await locator.waitFor({ timeout, state: 'visible' });
          break;
      }
    };

    try {
      await executeAction();
    } catch (err) {
      // Retry once on navigation / network errors.
      if (err instanceof Error && /navigation|net::ERR/i.test(err.message)) {
        try {
          await executeAction();
        } catch (retryErr) {
          actionError = retryErr;
        }
      } else {
        actionError = err;
      }
    }

    // Check post-action URL for policy violations.
    const postActionUrl = page.url();
    if (postActionUrl !== preActionUrl) {
      const postPolicy = enforceDomainPolicy(postActionUrl, this.config);
      if (!postPolicy.allowed) {
        // Navigate back best-effort — do not throw if it fails.
        await page.goBack().catch(() => { /* best-effort */ });
        return {
          outcome: 'blocked_by_policy',
          url: postActionUrl,
          reason: postPolicy.reason,
        };
      }
    }

    // Capture screenshot if requested or if action threw.
    let screenshotPath: string | null = null;
    if (input.screenshot === true || actionError !== null) {
      screenshotPath = await this.captureScreenshot(page, sessionId, 'browser_act');
    }

    // Build post-action observation.
    state.observationCounter += 1;
    const obs = await observePage(page, {
      observationCounter: state.observationCounter,
      screenshotPath,
      consoleErrors: this.launcher.getConsoleErrorCount(sessionId),
      httpStatus: this.launcher.getLastHttpStatus(sessionId),
      hasDialog: this.launcher.hasOpenDialog(sessionId),
    });

    const actionTag = `browser_act:${input.action}`;
    this.updateSessionFromObservation(state, obs.interactive, obs.url, obs.title, actionTag);

    // Re-throw action errors after capturing the observation.
    if (actionError !== null) {
      throw actionError;
    }

    return obs;
  }

  // -------------------------------------------------------------------------
  // render()
  // -------------------------------------------------------------------------

  /**
   * One-shot content fetch in an ephemeral context. See the `BrowserProvider`
   * interface contract: deliberately bypasses the domain-allowlist policy
   * because this is a content-fetch primitive (the `web_scrape` markdown
   * escalation path), not interactive agent navigation. Delegates the
   * context lifecycle to `BrowserLauncher.renderHtml()`.
   */
  async render(input: RenderInput): Promise<RenderResult> {
    return this.launcher.renderHtml(input.url, {
      timeoutMs: input.timeoutMs ?? 30000,
      waitUntil: input.waitFor ?? 'load',
      signal: input.signal,
    });
  }

  // -------------------------------------------------------------------------
  // screenshot()
  // -------------------------------------------------------------------------

  /**
   * Capture a screenshot of the current page or a specific element.
   *
   * Contract:
   *   - If `input.target` is provided, resolves it first. Ambiguous targets
   *     throw (not a structured outcome) because the caller asked for a
   *     specific element and we can't pick one.
   *   - Width/height: from viewportSize() for viewport shots, or from
   *     document scroll dimensions for full-page — best-effort.
   */
  async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    const { sessionId } = input;
    const page = this.launcher.getPage(sessionId);
    if (page === undefined) {
      throw new Error(`browser_screenshot: no page open for session ${sessionId}`);
    }

    const state = this.ensureSessionState(sessionId);
    let buf: Buffer;

    if (input.target !== undefined) {
      // Resolve the target.
      const resolution = await resolveTarget(page, input.target, state.knownElements);
      if (resolution.outcome === 'not_found') {
        throw new Error(`browser_screenshot: target not found: ${describeTarget(input.target)}`);
      }
      if (resolution.outcome === 'ambiguous_target') {
        throw new Error('screenshot target ambiguous; specify element_id or selector');
      }
      // Capture the element screenshot.
      buf = await resolution.locator.screenshot() as Buffer;
    } else {
      buf = await page.screenshot({ fullPage: input.fullPage ?? false }) as Buffer;
    }

    const { path, bytes } = await writeScreenshotSidecar(sessionId, buf, 'browser_screenshot');

    // Determine width/height.
    let width = 0;
    let height = 0;

    if (input.fullPage === true) {
      // Full-page dimensions from document scroll dimensions.
      try {
        const dims = await page.evaluate((): { w: number; h: number } => ({
          w: document.documentElement.scrollWidth,
          h: document.documentElement.scrollHeight,
        }));
        width = dims.w;
        height = dims.h;
      } catch {
        // Fall back to viewport.
        const vp = page.viewportSize();
        width = vp?.width ?? 0;
        height = vp?.height ?? 0;
      }
    } else {
      // Viewport dimensions.
      const vp = page.viewportSize();
      width = vp?.width ?? 0;
      height = vp?.height ?? 0;
    }

    return {
      path,
      bytes,
      width,
      height,
      // Raw PNG bytes for the model to read visually. The 5 MiB sidecar cap in
      // writeScreenshotSidecar() (called above) already bounded `buf` — under
      // the direct Messages API's 10 MB base64 ceiling (note: Bedrock/Vertex
      // cap tighter at 5 MB base64). The orthogonal 8000px pixel limit is
      // enforced in the browser_screenshot handler, which falls back to
      // text-only when width/height exceed it: bytes bounded here, pixels there.
      dataBase64: buf.toString('base64'),
      mediaType: 'image/png',
    };
  }

  // -------------------------------------------------------------------------
  // extract()
  // -------------------------------------------------------------------------

  /**
   * Extract structured data from the current page using a JSON Schema.
   *
   * Invariant: Phase 1 does not implement extraction. Callers receive a clear
   * Error so the dispatcher wraps it as ToolResult { isError: true } with a
   * message that explains the feature timeline. Do NOT change this to a
   * structured outcome — the tool handler knows to expect exceptions for
   * unimplemented features.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async extract(_input: ExtractInput): Promise<ExtractResult> {
    throw new Error('browser_extract not implemented in Phase 1');
  }

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  /**
   * Tear down this session's BrowserContext. Idempotent.
   *
   * Invariant: the browser process itself is left alive for other sessions.
   * Only the context (and its page) for `input.sessionId` is torn down.
   */
  async close(input: CloseInput): Promise<void> {
    await this.launcher.closeSession(input.sessionId);
    this.sessions.delete(input.sessionId);
  }

  // -------------------------------------------------------------------------
  // describe()
  // -------------------------------------------------------------------------

  /**
   * Read-only introspection. Never throws.
   *
   * Returns `null` when no session state exists for `sessionId`. Otherwise
   * returns a `BrowserProviderState` snapshot derived from in-memory state.
   */
  describe(sessionId: string): BrowserProviderState | null {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return null;
    }
    const page = this.launcher.getPage(sessionId);
    return {
      active: page !== undefined,
      url: state.currentUrl,
      title: state.currentTitle,
      lastAction: state.lastAction,
      lastActionAt: state.lastActionAt,
      openTabs: page !== undefined ? 1 : 0,
    };
  }

  // -------------------------------------------------------------------------
  // shutdown()
  // -------------------------------------------------------------------------

  /**
   * Process-level teardown. Clears all session state and shuts down the
   * browser. Idempotent — safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    this.sessions.clear();
    await this.launcher.shutdown();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Get or create the SessionState for `sessionId`.
   */
  private ensureSessionState(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: SessionState = {
      observationCounter: 0,
      knownElements: new Map(),
      lastAction: null,
      lastActionAt: null,
      currentUrl: null,
      currentTitle: null,
    };
    this.sessions.set(sessionId, fresh);
    return fresh;
  }

  /**
   * Update session state from a newly-built observation.
   *
   * Rebuilds `knownElements` from the observation's `interactive` list so
   * subsequent `act()` calls can resolve `element_id` targets.
   */
  private updateSessionFromObservation(
    state: SessionState,
    interactive: readonly InteractiveElement[],
    url: string,
    title: string,
    actionTag: string,
  ): void {
    state.knownElements = new Map(interactive.map((el) => [el.id, el]));
    state.currentUrl = url;
    state.currentTitle = title;
    state.lastAction = actionTag;
    state.lastActionAt = new Date().toISOString();
  }

  /**
   * Capture a screenshot and write the sidecar file.
   * Returns the absolute path, or null on failure (non-fatal).
   */
  private async captureScreenshot(
    page: Page,
    sessionId: string,
    tool: 'browser_open' | 'browser_observe' | 'browser_act' | 'browser_screenshot' | 'browser_extract',
  ): Promise<string | null> {
    try {
      const buf = await page.screenshot({ fullPage: false }) as Buffer;
      const { path } = await writeScreenshotSidecar(sessionId, buf, tool);
      return path;
    } catch {
      return null;
    }
  }
}
