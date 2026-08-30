/**
 * Browser backend routing -- selects the optimal backend for a session.
 *
 * Routing rules (in priority order):
 *   1. Explicit `backend: 'playwright'` or `backend: 'agent-browser'` in config
 *      bypasses all heuristics and uses that backend unconditionally.
 *   2. `backend: 'auto'` (the default) runs the selection heuristics:
 *      a. Agent Browser is EXCLUDED when ANY of these hold:
 *         - Surface is `daemon` or `subagent` (unattended execution)
 *         - Process is headless (`config.headless === true`)
 *         - Agent Browser is not available (connection file missing, PID dead,
 *           health probe failed)
 *      b. Otherwise, Agent Browser is preferred.
 *
 * Telemetry: every routing decision emits a `RoutingDecision` record that
 * captures the selected backend, the reason, and the probe latency. This is
 * surfaced via `BrowserEventPayload.backend` in the witness trace.
 *
 * @module browser/routing
 */

import type { BrowserConfig } from './types.js';
import {
  checkAvailability,
  type AvailabilityResult,
} from './agent-browser/connection.js';

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

export type RoutingBackend = 'playwright' | 'agent-browser';

export interface RoutingDecision {
  /** Which backend was selected. */
  backend: RoutingBackend;
  /** Human-readable reason for the selection. */
  reason: string;
  /** Wall-clock ms spent probing Agent Browser availability. 0 when skipped. */
  probeMs: number;
  /** The raw availability result when a probe ran. `null` when skipped. */
  availability: AvailabilityResult | null;
}

// ---------------------------------------------------------------------------
// Fallback-excluded surfaces
// ---------------------------------------------------------------------------

/**
 * Surfaces where Agent Browser is never used, even if available. These run
 * unattended and need Playwright's headless mode for reliability.
 */
const AGENT_BROWSER_EXCLUDED_SURFACES = new Set([
  'daemon',
  'subagent',
]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface RoutingContext {
  config: BrowserConfig;
  /** Current execution surface. `undefined` when unknown. */
  surface?: string;
}

/**
 * Select the browser backend for a session. This is called once per
 * `getBrowserProvider()` construction -- the decision is cached for the
 * process lifetime (one provider per process).
 */
export async function selectBackend(
  ctx: RoutingContext,
): Promise<RoutingDecision> {
  const { config, surface } = ctx;

  // Explicit backend -- no heuristics.
  if (config.backend === 'playwright') {
    return {
      backend: 'playwright',
      reason: 'explicit config: backend=playwright',
      probeMs: 0,
      availability: null,
    };
  }

  if (config.backend === 'agent-browser') {
    // Explicit Agent Browser. Still probe availability -- fail loudly if not
    // running rather than silently degrading.
    const t0 = Date.now();
    const avail = await checkAvailability();
    const probeMs = Date.now() - t0;

    if (!avail.available) {
      // Requested explicitly but not available -- throw so the caller
      // gets a clear error instead of a silent fallback.
      throw new Error(
        `AFK_BROWSER_BACKEND=agent-browser but Agent Browser is not available: ${avail.reason}`,
      );
    }

    return {
      backend: 'agent-browser',
      reason: 'explicit config: backend=agent-browser',
      probeMs,
      availability: avail,
    };
  }

  // Auto mode -- run heuristics.

  // Check surface exclusions.
  if (surface && AGENT_BROWSER_EXCLUDED_SURFACES.has(surface)) {
    return {
      backend: 'playwright',
      reason: `auto: surface "${surface}" excluded from Agent Browser`,
      probeMs: 0,
      availability: null,
    };
  }

  // Check headless mode -- Agent Browser has no headless mode.
  if (config.headless) {
    return {
      backend: 'playwright',
      reason: 'auto: headless mode requires Playwright',
      probeMs: 0,
      availability: null,
    };
  }

  // Probe Agent Browser availability.
  const t0 = Date.now();
  const avail = await checkAvailability();
  const probeMs = Date.now() - t0;

  if (!avail.available) {
    return {
      backend: 'playwright',
      reason: `auto: Agent Browser unavailable (${avail.reason})`,
      probeMs,
      availability: avail,
    };
  }

  return {
    backend: 'agent-browser',
    reason: 'auto: Agent Browser available and preferred',
    probeMs,
    availability: avail,
  };
}
