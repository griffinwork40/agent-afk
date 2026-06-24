/**
 * Handler for the `browser_observe` tool.
 *
 * Re-snapshots the current page without performing any action and returns
 * the fresh `BrowserObservation` as JSON. Useful after waiting for
 * async content to settle or after an action that triggered in-page DOM
 * mutations not captured in the previous observation.
 *
 * Throws if no page is currently open for this session — the provider
 * converts that to a descriptive message which the handler surfaces as
 * `isError: true`.
 *
 * @module agent/tools/handlers/browser-observe
 */

import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { BrowserHandlerOptions } from './browser-open.js';
import { env } from '../../../config/env.js';
import { emitBrowserEvent } from '../../trace/emit.js';

import { isPlaywrightMissing, playwrightMissingHint } from './playwright-hints.js';

interface ParsedObserveInput {
  screenshot?: boolean;
  includeHidden?: boolean;
  maxElements?: number;
}

function parseInput(raw: unknown): ParsedObserveInput | { error: string } {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    return { error: 'browser_observe: input must be an object or omitted' };
  }
  if (!raw) return {};

  const obj = raw as Record<string, unknown>;

  let screenshot: boolean | undefined;
  if (obj['screenshot'] !== undefined) {
    if (typeof obj['screenshot'] !== 'boolean') {
      return { error: 'browser_observe: "screenshot" must be a boolean' };
    }
    screenshot = obj['screenshot'];
  }

  let includeHidden: boolean | undefined;
  if (obj['include_hidden'] !== undefined) {
    if (typeof obj['include_hidden'] !== 'boolean') {
      return { error: 'browser_observe: "include_hidden" must be a boolean' };
    }
    includeHidden = obj['include_hidden'];
  }

  let maxElements: number | undefined;
  if (obj['max_elements'] !== undefined) {
    if (
      typeof obj['max_elements'] !== 'number' ||
      !Number.isFinite(obj['max_elements']) ||
      obj['max_elements'] <= 0 ||
      !Number.isInteger(obj['max_elements'])
    ) {
      return { error: 'browser_observe: "max_elements" must be a positive integer' };
    }
    maxElements = obj['max_elements'];
  }

  return { screenshot, includeHidden, maxElements };
}

export function createBrowserObserveHandler(opts: BrowserHandlerOptions = {}): ToolHandler {
  return async (input, signal, context?: ToolHandlerContext) => {
    // Pre-aborted short-circuit.
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `browser_observe aborted: ${msg}`, isError: true };
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
      return { content: `browser_observe failed to get provider: ${msg}`, isError: true };
    }

    const t0 = Date.now();
    try {
      const obs = await provider.observe({
        sessionId,
        screenshot: parsed.screenshot,
        includeHidden: parsed.includeHidden,
        maxElements: parsed.maxElements,
      });
      const durationMs = Date.now() - t0;
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_observe',
        toolUseId: context?.toolUseId ?? '',
        urlBefore: obs.url,
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
        tool: 'browser_observe',
        toolUseId: context?.toolUseId ?? '',
        urlBefore: null,
        urlAfter: null,
        status: 'error',
        durationMs,
        error: { reason: msg, recoverable: false },
      });
      return { content: `browser_observe failed: ${msg}`, isError: true };
    }
  };
}

export const browserObserveHandler: ToolHandler = createBrowserObserveHandler();
