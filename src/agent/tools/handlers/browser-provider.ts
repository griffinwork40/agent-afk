/**
 * Shared provider-acquisition preamble for the `browser_*` tool handlers.
 *
 * Every browser handler (open, observe, act, screenshot) needs the same
 * boilerplate before it can call the provider:
 *   1. Read + validate `AFK_SESSION_ID` from env.
 *   2. Acquire the `BrowserProvider` singleton (or an injected test double).
 *   3. Capture the last routing decision for trace events.
 *   4. Surface a friendly install hint if Playwright is missing.
 *
 * Extracting this into `acquireBrowserProvider()` removes ~28 duplicated lines
 * per handler (≈84 LOC across four files) and ensures the error messages and
 * validation logic stay in sync. Each handler's unique business logic stays in
 * its own file.
 *
 * @module agent/tools/handlers/browser-provider
 */

import type { BrowserProvider } from '../../../browser/provider.js';
import { env } from '../../../config/env.js';
import { isPlaywrightMissing, playwrightMissingHint } from './playwright-hints.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by every `create*Handler()` factory. The optional
 * `getBrowserProvider` override lets tests inject a mock without launching a
 * real browser or importing the real registry.
 */
export interface BrowserHandlerOptions {
  /**
   * Inject a getBrowserProvider function for tests without launching a real
   * browser. Defaults to the real registry import.
   */
  getBrowserProvider?: () => Promise<BrowserProvider>;
}

/**
 * The successful result of `acquireBrowserProvider()`. Callers destructure
 * this to access the provider and optional routing telemetry.
 *
 * The `ok: true` discriminant enables TypeScript to narrow the union after
 * the `if (!acquired.ok) return acquired` guard at each call site.
 */
export interface AcquiredBrowserProvider {
  /** Discriminant — always `true` on the success branch. */
  ok: true;
  /** Validated session identifier derived from `AFK_SESSION_ID`. */
  sessionId: string;
  /** The resolved `BrowserProvider` singleton (or test double). */
  provider: BrowserProvider;
  /** Backend name from the last routing decision, if any. */
  routingBackend: string | undefined;
  /** Routing reason from the last routing decision, if any. */
  routingReason: string | undefined;
}

/**
 * Error result returned when acquisition fails. The `content` field is
 * ready to surface directly as `{ content, isError: true }` in a
 * `ToolResult`.
 *
 * The `ok: false` discriminant pairs with `AcquiredBrowserProvider.ok: true`
 * so TypeScript narrows correctly after `if (!acquired.ok) return acquired`.
 */
export interface AcquireError {
  ok: false;
  isError: true;
  content: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Acquire the browser provider for a tool handler call.
 *
 * @param toolName  Snake-case tool name used in error messages
 *                  (e.g. `'browser_open'`).
 * @param opts      Handler-level options; `getBrowserProvider` is used when
 *                  present, otherwise the real registry is imported lazily.
 *
 * @returns `AcquiredBrowserProvider` on success, or `AcquireError` on
 *          failure (invalid session-id, Playwright missing, provider init
 *          error). Callers should check for `isError` in the result.
 */
export async function acquireBrowserProvider(
  toolName: string,
  opts: BrowserHandlerOptions,
): Promise<AcquiredBrowserProvider | AcquireError> {
  // 1. Validate the session identifier.
  const sessionId = env.AFK_SESSION_ID ?? 'default';
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return {
      ok: false,
      isError: true,
      content: `Invalid AFK_SESSION_ID: must match /^[a-zA-Z0-9_-]+$/, got: ${JSON.stringify(sessionId)}`,
    };
  }

  // 2. Acquire the provider and routing decision.
  let provider: BrowserProvider;
  let routingBackend: string | undefined;
  let routingReason: string | undefined;

  try {
    if (opts.getBrowserProvider) {
      provider = await opts.getBrowserProvider();
    } else {
      const { getBrowserProvider, getLastRoutingDecision } = await import('../../../browser/registry.js');
      provider = await getBrowserProvider();
      const decision = getLastRoutingDecision();
      if (decision) {
        routingBackend = decision.backend;
        routingReason = decision.reason;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isPlaywrightMissing(msg)) {
      return { ok: false, isError: true, content: playwrightMissingHint(msg) };
    }
    return { ok: false, isError: true, content: `${toolName} failed to get provider: ${msg}` };
  }

  return { ok: true, sessionId, provider, routingBackend, routingReason };
}
