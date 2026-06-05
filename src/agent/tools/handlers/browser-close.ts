/**
 * Handler for the `browser_close` tool.
 *
 * Tears down the current session's `BrowserContext`. The underlying browser
 * process is kept alive for any other sessions that may be running. This
 * call is idempotent — closing an already-closed session is a no-op.
 *
 * No input fields are required. Any provided fields are silently ignored.
 *
 * @module agent/tools/handlers/browser-close
 */

import type { ToolHandler } from '../types.js';
import type { BrowserHandlerOptions } from './browser-open.js';
import { env } from '../../../config/env.js';

// History: browser_event witness emission is a no-op in this handler.
// See browser-open.ts for the full rationale.

const PLAYWRIGHT_MISSING_HINTS = ['Cannot find package', 'ERR_MODULE_NOT_FOUND'];

export function createBrowserCloseHandler(opts: BrowserHandlerOptions = {}): ToolHandler {
  return async (_input, signal) => {
    // Pre-aborted short-circuit.
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `browser_close aborted: ${msg}`, isError: true };
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
      return { content: `browser_close failed to get provider: ${msg}`, isError: true };
    }

    try {
      await provider.close({ sessionId });
      return { content: 'Browser session closed.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `browser_close failed: ${msg}`, isError: true };
    }
  };
}

export const browserCloseHandler: ToolHandler = createBrowserCloseHandler();
