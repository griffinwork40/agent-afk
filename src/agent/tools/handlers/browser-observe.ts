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

import type { ToolHandler } from '../types.js';
import type { BrowserHandlerOptions } from './browser-open.js';
import { env } from '../../../config/env.js';

// History: browser_event witness emission is a no-op in this handler.
// See the matching comment in browser-open.ts for the full rationale.
// Short version: ToolHandlerContext carries no TraceWriter today; the
// dispatcher already emits surrounding tool_call events; browser_event
// wiring is deferred to a follow-up PR.

const PLAYWRIGHT_MISSING_HINTS = ['Cannot find package', 'ERR_MODULE_NOT_FOUND'];

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
  return async (input, signal) => {
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
      if (PLAYWRIGHT_MISSING_HINTS.some((hint) => msg.includes(hint))) {
        return {
          content:
            'browser tools require the optional `playwright` peer dependency. ' +
            'Install via: pnpm add playwright. Or pick a different tool.',
          isError: true,
        };
      }
      return { content: `browser_observe failed to get provider: ${msg}`, isError: true };
    }

    try {
      const obs = await provider.observe({
        sessionId,
        screenshot: parsed.screenshot,
        includeHidden: parsed.includeHidden,
        maxElements: parsed.maxElements,
      });
      return { content: JSON.stringify(obs, null, 2) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `browser_observe failed: ${msg}`, isError: true };
    }
  };
}

export const browserObserveHandler: ToolHandler = createBrowserObserveHandler();
