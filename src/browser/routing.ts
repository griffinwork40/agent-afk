/**
 * Browser backend routing -- selects the backend for a session.
 *
 * Playwright is now the only supported backend. `backend: 'auto'` resolves to
 * Playwright. The legacy value `backend: 'agent-browser'` also resolves to
 * Playwright and emits a one-time deprecation warning so users with old env /
 * config files are not silently broken.
 *
 * @module browser/routing
 */

import type { BrowserConfig } from './types.js';

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

export type RoutingBackend = 'playwright';

export interface RoutingDecision {
  /** Which backend was selected. Always 'playwright'. */
  backend: RoutingBackend;
  /** Human-readable reason for the selection. */
  reason: string;
  /** Wall-clock ms spent on any probing. Always 0 (no probe needed). */
  probeMs: number;
  /** Always null -- agent-browser probing is removed. */
  availability: null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface RoutingContext {
  config: BrowserConfig;
  /** Current execution surface. `undefined` when unknown. */
  surface?: string;
}

/**
 * Select the browser backend for a session. Always returns Playwright.
 * `backend: 'auto'` and `backend: 'playwright'` both resolve to Playwright.
 *
 * The legacy value `'agent-browser'` is handled upstream in `config.ts`
 * (resolved to `'playwright'` with a deprecation warning), so by the time
 * this function is called the config only contains `'playwright'` or `'auto'`.
 */
export function selectBackend(ctx: RoutingContext): RoutingDecision {
  const { config } = ctx;

  if (config.backend === 'playwright') {
    return {
      backend: 'playwright',
      reason: 'explicit config: backend=playwright',
      probeMs: 0,
      availability: null,
    };
  }

  // 'auto' → playwright (the only backend)
  return {
    backend: 'playwright',
    reason: 'auto: playwright is the only backend',
    probeMs: 0,
    availability: null,
  };
}
