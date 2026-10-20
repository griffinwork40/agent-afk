/**
 * OTLP/HTTP push: POST an already-built ExportTraceServiceRequest payload to a
 * remote collector endpoint.
 *
 * This is the live-export complement to the offline converter in
 * `otlp-export.ts`. It is deliberately extracted into its own file so:
 *   - The core converter stays a pure function with no I/O.
 *   - Tests can mock `fetch` at the module boundary without touching the
 *     converter.
 *   - The 350-line file ceiling is respected for both files.
 *
 * ## Design choices
 *
 * - Uses the global `fetch` (available in Node ≥18; required ≥22 by AFK).
 *   No additional runtime dependency.
 * - Fire-and-forget semantics: a dead endpoint never blocks or fails the
 *   caller. All network errors are caught and returned as a structured result.
 * - One POST per call; no retry, no queue. Retry belongs in the collector
 *   (standard OTLP collector protocol).
 * - `AFK_OTLP_HEADERS` accepts a comma-separated list of `Key=Value` pairs
 *   (same format used by `otelcol` and Grafana Alloy). Additional headers
 *   supplied programmatically are merged, with programmatic headers winning.
 *
 * @module agent/trace/otlp-http-push
 */

import type { OtlpExportRequest } from './otlp-export.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single OTLP HTTP push attempt. */
export type OtlpPushResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };

/** Options for {@link pushOtlpHttp}. */
export interface OtlpHttpPushOptions {
  /**
   * OTLP/HTTP endpoint URL (e.g. `http://localhost:4318/v1/traces`).
   * Required.
   */
  endpoint: string;
  /**
   * Additional HTTP headers merged on top of the defaults
   * (`Content-Type: application/json`).  Caller-supplied headers win on
   * collision.
   */
  headers?: Record<string, string>;
  /**
   * Timeout in milliseconds before the request is aborted.
   * Defaults to 5000 ms.  A dead endpoint must never block a session.
   */
  timeoutMs?: number;
  /**
   * Injectable fetch implementation — for tests only.
   * Defaults to the global `fetch`.
   */
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Parse `AFK_OTLP_HEADERS` — a comma-separated `Key=Value` list — into a
 * plain object.  Malformed pairs (no `=`) are silently skipped.
 *
 * Example: `"Authorization=Bearer tok,X-Org=acme"` →
 *   `{ Authorization: 'Bearer tok', 'X-Org': 'acme' }`.
 */
export function parseOtlpHeaders(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue; // skip empty key or no '='
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP push
// ---------------------------------------------------------------------------

/**
 * POST an OTLP ExportTraceServiceRequest JSON payload to a collector endpoint.
 *
 * Never throws — all errors are returned as `{ ok: false, error }`.
 * A 4xx/5xx response is also returned as `{ ok: false }` so the caller can
 * log without needing a try/catch.
 */
export async function pushOtlpHttp(
  payload: OtlpExportRequest,
  opts: OtlpHttpPushOptions,
): Promise<OtlpPushResult> {
  const {
    endpoint,
    headers: extraHeaders = {},
    timeoutMs = 5_000,
    fetchFn = fetch,
  } = opts;

  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status} ${response.statusText}` };
    }
    return { ok: true, status: response.status };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
