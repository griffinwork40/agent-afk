/**
 * Optional post-connect MCP server health-check probe (issue #1751).
 *
 * `fromConfig()` already issues `tools/list` during the connect handshake.
 * This probe's **real delta** is a *second*, timeout-bounded `tools/list`
 * issued **after** all servers have finished their initial connect burst.
 * This catches servers that accept the handshake (and respond to the first
 * `tools/list`) but then stall on subsequent requests — a pattern that
 * surfaces only under load or after connection-pool warm-up.
 *
 * The probe is **OFF by default** (gated behind `AFK_MCP_HEALTHCHECK=1`)
 * because it adds one additional round-trip per server to cold-start latency
 * (see issue #1751 deferral note). Failures are surfaced as boot warnings;
 * they never prevent session start.
 *
 * @module agent/mcp/health-check
 */

import { env } from '../../config/env.js';
import { errorMessage } from '../../utils/errors.js';

/**
 * Per-server result returned by `runMcpHealthChecks()`.
 */
export interface McpHealthCheckResult {
  serverName: string;
  /** Whether the probe succeeded within the timeout. */
  healthy: boolean;
  /** Human-readable error message when `healthy` is false. */
  error?: string;
  /** Round-trip duration of the probe call, in milliseconds. */
  durationMs: number;
}

/**
 * Minimal interface the health-check probe needs from each connected server.
 * Matched by the real `McpClient`; also mockable in tests without the full
 * client.
 */
export interface HealthCheckTarget {
  /** Server name, used in warning messages. */
  serverName: string;
  /**
   * Re-issue `tools/list` against the live server. The health-check probe
   * calls this to verify the server is still responsive after the connect
   * burst settles. The probe passes an `AbortSignal` that fires on timeout
   * so the underlying request is cancelled rather than left dangling.
   */
  listTools(signal?: AbortSignal): Promise<unknown[]>;
}

/**
 * Default per-server probe timeout. Intentionally short — this is a
 * liveness ping, not a retry strategy. Servers that respond to the
 * initial handshake should answer this in well under a second.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Run a `tools/list` liveness probe against each target in parallel.
 *
 * Results are always returned (healthy or not); errors are surfaced as
 * `warn` messages so the caller (session bootstrap) can log them as boot
 * warnings without aborting the session.
 *
 * @param targets  Connected servers to probe.
 * @param timeoutMs  Per-server timeout (default `5000 ms`).
 */
export async function runMcpHealthChecks(
  targets: readonly HealthCheckTarget[],
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<McpHealthCheckResult[]> {
  const probes = targets.map((target) => probeServer(target, timeoutMs));
  const results = await Promise.allSettled(probes);
  return results.map((r) => {
    // probeServer never rejects — it always resolves with a result.
    // The allSettled wrapper is defensive.
    if (r.status === 'fulfilled') return r.value;
    return {
      serverName: '(unknown)',
      healthy: false,
      error: errorMessage(r.reason),
      durationMs: 0,
    };
  });
}

/**
 * Emit boot warnings for each unhealthy server via `console.warn`.
 * Call after `runMcpHealthChecks()` to surface failures without failing.
 */
export function warnUnhealthyServers(results: readonly McpHealthCheckResult[]): void {
  for (const r of results) {
    if (!r.healthy) {
      console.warn(
        `[mcp:${r.serverName}] health-check failed (${r.durationMs}ms): ${r.error ?? 'unknown error'}`,
      );
    }
  }
}

/**
 * Returns `true` when `AFK_MCP_HEALTHCHECK` is set to a truthy value
 * (`1`, `true`, `yes`, `on` — case-insensitive). Off by default.
 */
export function isMcpHealthCheckEnabled(): boolean {
  const raw = env.AFK_MCP_HEALTHCHECK;
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function probeServer(
  target: HealthCheckTarget,
  timeoutMs: number,
): Promise<McpHealthCheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  try {
    await withProbeTimeout(target.listTools(controller.signal), timeoutMs, target.serverName, controller);
    return { serverName: target.serverName, healthy: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      serverName: target.serverName,
      healthy: false,
      error: errorMessage(err),
      durationMs: Date.now() - start,
    };
  }
}

function withProbeTimeout<T>(
  p: Promise<T>,
  ms: number,
  serverName: string,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`MCP health-check for "${serverName}" timed out after ${ms}ms`);
      // Cancel the underlying tools/list so it does not linger past the deadline.
      controller.abort(err);
      reject(err);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
