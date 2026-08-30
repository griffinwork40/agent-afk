/**
 * Agent Browser-backed BrowserProvider implementation.
 *
 * Implements the `BrowserProvider` interface from `../provider.ts` using the
 * local Agent Browser native WebKit app via its HTTP API. Each AFK session
 * maps to one Agent Browser tab.
 *
 * Key differences from PlaywrightProvider:
 *   - Uses a visible native macOS browser (WebKit) instead of headless Chromium.
 *   - Element handles (`el_XXXXXX`) are generation-scoped and come from Agent
 *     Browser's own inspect endpoint, not Playwright's locator API.
 *   - `render()` falls through to Playwright -- Agent Browser has no headless
 *     mode, and render() requires ephemeral contexts.
 *   - Domain policy enforcement is applied locally before making API calls.
 *
 * Action execution and semantic target resolution are in `./actions.ts`.
 *
 * @module browser/agent-browser/index
 */

import type { BrowserProvider, OpenOutcome, ActOutcome } from '../provider.js';
import type {
  ActInput,
  BrowserConfig,
  BrowserObservation,
  BrowserPageStatus,
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
} from '../types.js';
import { enforceDomainPolicy } from '../config.js';
import { writeScreenshotSidecar } from '../witness.js';
import { AgentBrowserClient } from './client.js';
import type { AgentBrowserConnection } from './connection.js';
import {
  mapElement,
  resolveElementId,
  executeAction,
  resolveSemanticAndAct,
} from './actions.js';

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

export interface SessionState {
  tabId: string;
  observationCounter: number;
  knownElements: Map<string, InteractiveElement>;
  lastAction: string | null;
  lastActionAt: string | null;
  currentUrl: string | null;
  currentTitle: string | null;
}

// ---------------------------------------------------------------------------
// AgentBrowserProvider
// ---------------------------------------------------------------------------

export class AgentBrowserProvider implements BrowserProvider {
  readonly name = 'agent-browser';

  private readonly config: BrowserConfig;
  readonly client: AgentBrowserClient;
  private readonly sessions = new Map<string, SessionState>();

  constructor(config: BrowserConfig, connection: AgentBrowserConnection) {
    this.config = config;
    this.client = new AgentBrowserClient(connection);
  }

  // -------------------------------------------------------------------------
  // open()
  // -------------------------------------------------------------------------

  async open(input: OpenInput): Promise<OpenOutcome> {
    const policyResult = enforceDomainPolicy(input.url, this.config);
    if (!policyResult.allowed) {
      return {
        outcome: 'blocked_by_policy',
        url: input.url,
        reason: policyResult.reason,
      };
    }

    let state = this.sessions.get(input.sessionId);

    if (state) {
      await this.client.evalScript(
        state.tabId,
        `window.location.href = ${JSON.stringify(input.url)}`,
      );
      await this.client.waitFor(state.tabId, 'load', {
        timeout: input.timeoutMs ?? 30_000,
      });
    } else {
      const { tabId } = await this.client.openTab(input.url);
      await this.client.waitFor(tabId, 'load', {
        timeout: input.timeoutMs ?? 30_000,
      });
      state = {
        tabId,
        observationCounter: 0,
        knownElements: new Map(),
        lastAction: null,
        lastActionAt: null,
        currentUrl: null,
        currentTitle: null,
      };
      this.sessions.set(input.sessionId, state);
    }

    const readResult = await this.client.read(state.tabId, { mode: 'main' });
    const landedPolicy = enforceDomainPolicy(readResult.url, this.config);
    if (!landedPolicy.allowed) {
      return {
        outcome: 'blocked_by_policy',
        url: readResult.url,
        reason: `redirected to blocked domain: ${landedPolicy.reason}`,
      };
    }

    return this.buildObservation(state, input.sessionId, input.screenshot);
  }

  // -------------------------------------------------------------------------
  // observe()
  // -------------------------------------------------------------------------

  async observe(input: ObserveInput): Promise<BrowserObservation> {
    const state = this.sessions.get(input.sessionId);
    if (!state) {
      throw new Error(
        `No Agent Browser tab open for session ${input.sessionId}. Call browser_open first.`,
      );
    }
    return this.buildObservation(state, input.sessionId, input.screenshot, input.maxElements);
  }

  // -------------------------------------------------------------------------
  // act()
  // -------------------------------------------------------------------------

  async act(input: ActInput): Promise<ActOutcome> {
    const state = this.sessions.get(input.sessionId);
    if (!state) {
      throw new Error(
        `No Agent Browser tab open for session ${input.sessionId}. Call browser_open first.`,
      );
    }

    const elementId = resolveElementId(state.knownElements, input.target);
    if (elementId === null) {
      if (input.target.kind === 'semantic') {
        const result = await resolveSemanticAndAct(
          { client: this.client, config: this.config, tabId: state.tabId },
          input,
        );
        // If it returned an outcome (ambiguous/blocked), pass it through.
        if ('outcome' in result) return result;
        // Otherwise, it succeeded -- update state and build observation.
        state.lastAction = `browser_act:${input.action}`;
        state.lastActionAt = new Date().toISOString();
        return this.buildObservation(state, input.sessionId, input.screenshot);
      }
      throw new Error(`Cannot resolve target: ${JSON.stringify(input.target)}`);
    }

    await executeAction(this.client, state.tabId, input.action, elementId, input.value, input.timeoutMs);
    state.lastAction = `browser_act:${input.action}`;
    state.lastActionAt = new Date().toISOString();

    const readResult = await this.client.read(state.tabId, { mode: 'main' });
    const policy = enforceDomainPolicy(readResult.url, this.config);
    if (!policy.allowed) {
      return {
        outcome: 'blocked_by_policy',
        url: readResult.url,
        reason: `action navigated to blocked domain: ${policy.reason}`,
      };
    }

    return this.buildObservation(state, input.sessionId, input.screenshot);
  }

  // -------------------------------------------------------------------------
  // render() -- not supported; callers fall back to Playwright
  // -------------------------------------------------------------------------

  async render(_input: RenderInput): Promise<RenderResult> {
    throw new Error(
      'AgentBrowserProvider does not support render(). ' +
      'Use PlaywrightProvider for one-shot content fetches.',
    );
  }

  // -------------------------------------------------------------------------
  // screenshot()
  // -------------------------------------------------------------------------

  async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    const state = this.sessions.get(input.sessionId);
    if (!state) {
      throw new Error(
        `No Agent Browser tab open for session ${input.sessionId}. Call browser_open first.`,
      );
    }
    const result = await this.client.screenshot(state.tabId);
    const buf = Buffer.from(result.data, 'base64');
    const sidecar = await writeScreenshotSidecar(input.sessionId, buf, 'browser_screenshot');
    return {
      path: sidecar.path,
      bytes: buf.length,
      width: 0,
      height: 0,
      dataBase64: result.data,
      mediaType: 'image/png',
    };
  }

  // -------------------------------------------------------------------------
  // extract() -- not yet supported
  // -------------------------------------------------------------------------

  async extract(_input: ExtractInput): Promise<ExtractResult> {
    throw new Error('AgentBrowserProvider does not support extract() yet.');
  }

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  async close(input: CloseInput): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (!state) return;
    try {
      await this.client.closeTab(state.tabId);
    } catch { /* tab may already be closed */ }
    this.sessions.delete(input.sessionId);
  }

  // -------------------------------------------------------------------------
  // describe()
  // -------------------------------------------------------------------------

  describe(sessionId: string): BrowserProviderState | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      active: true,
      url: state.currentUrl,
      title: state.currentTitle,
      lastAction: state.lastAction,
      lastActionAt: state.lastActionAt,
      openTabs: 1,
    };
  }

  // -------------------------------------------------------------------------
  // shutdown()
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    const closePromises = Array.from(this.sessions.entries()).map(
      async ([, state]) => {
        try { await this.client.closeTab(state.tabId); } catch { /* best-effort */ }
      },
    );
    await Promise.all(closePromises);
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async buildObservation(
    state: SessionState,
    sessionId: string,
    screenshot?: boolean,
    maxElements?: number,
  ): Promise<BrowserObservation> {
    const [readResult, inspectResult] = await Promise.all([
      this.client.read(state.tabId, { mode: 'main', budget: 4000 }),
      this.client.inspect(state.tabId, { mode: 'interactive', limit: maxElements ?? 80 }),
    ]);

    const interactive = inspectResult.elements.map(mapElement);
    const cap = maxElements ?? 80;
    const capped = interactive.slice(0, cap);

    state.observationCounter += 1;
    state.knownElements = new Map(capped.map((el) => [el.id, el]));
    state.currentUrl = readResult.url;
    state.currentTitle = readResult.title;

    const warnings: string[] = [];
    if (interactive.length > cap) {
      warnings.push(`page has ${interactive.length} interactive elements; showing first ${cap}`);
    }

    let screenshotPath: string | null = null;
    if (screenshot) {
      try {
        const ssResult = await this.client.screenshot(state.tabId);
        const buf = Buffer.from(ssResult.data, 'base64');
        const sidecar = await writeScreenshotSidecar(sessionId, buf, 'browser_open');
        screenshotPath = sidecar.path;
      } catch {
        warnings.push('screenshot capture failed');
      }
    }

    const obsId = `obs_${state.observationCounter.toString(36)}`;
    const pageStatus: BrowserPageStatus = {
      httpStatus: null,
      loadingState: 'idle',
      hasDialog: false,
      consoleErrors: 0,
    };

    return {
      observationId: obsId,
      url: readResult.url,
      title: readResult.title,
      textSummary: readResult.content.slice(0, 4000),
      interactive: capped,
      status: pageStatus,
      warnings,
      screenshotPath,
      capturedAt: new Date().toISOString(),
    };
  }
}
