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

import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { BrowserHandlerOptions } from './browser-provider.js';
import { emitBrowserEvent } from '../../trace/emit.js';
import { acquireBrowserProvider } from './browser-provider.js';
import { errorMessage } from '../../../utils/errors.js';

export function createBrowserCloseHandler(opts: BrowserHandlerOptions = {}): ToolHandler {
  return async (_input, signal, context?: ToolHandlerContext) => {
    // Pre-aborted short-circuit.
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `browser_close aborted: ${msg}`, isError: true };
    }

    const acquired = await acquireBrowserProvider('browser_close', opts);
    if (!acquired.ok) return acquired;
    const { sessionId, provider, routingBackend, routingReason } = acquired;

    const t0 = Date.now();
    try {
      await provider.close({ sessionId });
      const durationMs = Date.now() - t0;
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_close',
        toolUseId: context?.toolUseId ?? '',
        ...(routingBackend ? { backend: routingBackend as 'playwright' | 'agent-browser' } : {}),
        ...(routingReason ? { backendReason: routingReason } : {}),
        urlBefore: null,
        urlAfter: null,
        status: 'ok',
        durationMs,
      });
      return { content: 'Browser session closed.' };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const msg = errorMessage(err);
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_close',
        toolUseId: context?.toolUseId ?? '',
        ...(routingBackend ? { backend: routingBackend as 'playwright' | 'agent-browser' } : {}),
        ...(routingReason ? { backendReason: routingReason } : {}),
        urlBefore: null,
        urlAfter: null,
        status: 'error',
        durationMs,
        error: { reason: msg, recoverable: false },
      });
      return { content: `browser_close failed: ${msg}`, isError: true };
    }
  };
}

export const browserCloseHandler: ToolHandler = createBrowserCloseHandler();
