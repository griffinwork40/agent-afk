/**
 * Handler for the `browser_open` tool.
 *
 * Navigates the session's browser tab to a URL and returns the resulting
 * `BrowserObservation` as JSON. Creates the browser context lazily on first
 * call (via the provider singleton in `src/browser/registry.ts`).
 *
 * Pattern-matches on the `OpenOutcome` discriminated union:
 *   - `BrowserObservation`  → `{ content: JSON.stringify(obs) }`
 *   - `BlockedByPolicy`     → `{ content: ..., isError: true }`
 *
 * If the `playwright` optional peer dependency is missing the registry's
 * lazy import will throw. We catch that specific failure and surface a
 * friendly install hint rather than an opaque stack trace.
 *
 * @module agent/tools/handlers/browser-open
 */

import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { BrowserObservation } from '../../../browser/types.js';
import { env } from '../../../config/env.js';
import { emitBrowserEvent } from '../../trace/emit.js';

import {
  browserTimeoutFailureClass,
  isPlaywrightMissing,
  playwrightMissingHint,
} from './playwright-hints.js';

type WaitForOption = 'load' | 'domcontentloaded' | 'networkidle';

const VALID_WAIT_FOR: readonly WaitForOption[] = ['load', 'domcontentloaded', 'networkidle'];

interface ParsedOpenInput {
  url: string;
  waitFor?: WaitForOption;
  screenshot?: boolean;
  timeoutMs?: number;
}

function parseInput(raw: unknown): ParsedOpenInput | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'browser_open: input must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  const url = obj['url'];
  if (typeof url !== 'string' || url.length === 0) {
    return { error: 'browser_open: "url" is required and must be a non-empty string' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: `browser_open: "${url}" is not a valid absolute URL` };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { error: `browser_open: protocol "${parsedUrl.protocol}" is not supported (http/https only)` };
  }

  let waitFor: WaitForOption | undefined;
  if (obj['wait_for'] !== undefined) {
    if (!VALID_WAIT_FOR.includes(obj['wait_for'] as WaitForOption)) {
      return {
        error: `browser_open: "wait_for" must be one of ${VALID_WAIT_FOR.map((v) => `"${v}"`).join(', ')} (got ${JSON.stringify(obj['wait_for'])})`,
      };
    }
    waitFor = obj['wait_for'] as WaitForOption;
  }

  let screenshot: boolean | undefined;
  if (obj['screenshot'] !== undefined) {
    if (typeof obj['screenshot'] !== 'boolean') {
      return { error: 'browser_open: "screenshot" must be a boolean' };
    }
    screenshot = obj['screenshot'];
  }

  let timeoutMs: number | undefined;
  if (obj['timeout_ms'] !== undefined) {
    if (typeof obj['timeout_ms'] !== 'number' || !Number.isFinite(obj['timeout_ms']) || obj['timeout_ms'] <= 0) {
      return { error: 'browser_open: "timeout_ms" must be a positive finite number' };
    }
    timeoutMs = obj['timeout_ms'];
  }

  return { url: parsedUrl.toString(), waitFor, screenshot, timeoutMs };
}

export interface BrowserHandlerOptions {
  /**
   * Inject a getBrowserProvider function for tests without launching a real
   * browser. Defaults to the real registry import.
   */
  getBrowserProvider?: () => Promise<import('../../../browser/provider.js').BrowserProvider>;
}

export function createBrowserOpenHandler(opts: BrowserHandlerOptions = {}): ToolHandler {
  return async (input, signal, context?: ToolHandlerContext) => {
    // Pre-aborted short-circuit.
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `browser_open aborted: ${msg}`, isError: true, failureClass: 'abort' };
    }

    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    const sessionId = env.AFK_SESSION_ID ?? 'default';
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return {
        content: `Invalid AFK_SESSION_ID: must match /^[a-zA-Z0-9_-]+$/, got: ${JSON.stringify(sessionId)}`,
        isError: true,
      };
    }

    let provider: import('../../../browser/provider.js').BrowserProvider;
    try {
      if (opts.getBrowserProvider) {
        provider = await opts.getBrowserProvider();
      } else {
        const { getBrowserProvider } = await import('../../../browser/registry.js');
        provider = await getBrowserProvider();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isPlaywrightMissing(msg)) {
        return { content: playwrightMissingHint(msg), isError: true };
      }
      return { content: `browser_open failed to get provider: ${msg}`, isError: true };
    }

    const t0 = Date.now();
    try {
      const result = await provider.open({
        sessionId,
        url: parsed.url,
        waitFor: parsed.waitFor,
        screenshot: parsed.screenshot,
        timeoutMs: parsed.timeoutMs,
      });
      const durationMs = Date.now() - t0;

      if ('outcome' in result && result.outcome === 'blocked_by_policy') {
        void emitBrowserEvent(context?.traceWriter, {
          tool: 'browser_open',
          toolUseId: context?.toolUseId ?? '',
          urlBefore: null,
          urlAfter: null,
          status: 'blocked_by_policy',
          durationMs,
        });
        return {
          content: `browser_open blocked: ${result.reason}`,
          isError: true,
          failureClass: 'policy-refusal',
        };
      }

      // BrowserObservation — url is the post-load URL.
      // Cast is safe: the blocked_by_policy branch returned above, so result
      // is BrowserObservation here. TypeScript's 'outcome' in narrowing does
      // not flow through the early-return so we assert manually.
      const obs = result as BrowserObservation;
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_open',
        toolUseId: context?.toolUseId ?? '',
        urlBefore: null,
        urlAfter: obs.url,
        status: 'ok',
        durationMs,
        ...(obs.screenshotPath !== null ? { screenshotPath: obs.screenshotPath } : {}),
      });
      return { content: JSON.stringify(obs, null, 2) };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_open',
        toolUseId: context?.toolUseId ?? '',
        urlBefore: null,
        urlAfter: null,
        status: 'error',
        durationMs,
        error: { reason: msg, recoverable: false },
      });
      const failureClass = browserTimeoutFailureClass(err);
      return {
        content: `browser_open failed: ${msg}`,
        isError: true,
        ...(failureClass ? { failureClass } : {}),
      };
    }
  };
}

export const browserOpenHandler: ToolHandler = createBrowserOpenHandler();
