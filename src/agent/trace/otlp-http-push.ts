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
 *   (same format used by `otelcol` and Grafana Alloy). Values that contain a
 *   literal comma must be `%2C`-encoded; `parseOtlpHeaders` decodes them with
 *   `decodeURIComponent`. Additional headers supplied programmatically are
 *   merged, with the fixed `Content-Type: application/json` always winning.
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
   * Must use `http:` or `https:` scheme. Required.
   */
  endpoint: string;
  /**
   * Additional HTTP headers merged below the fixed
   * `Content-Type: application/json` (content-type is always JSON and cannot
   * be overridden by extra headers).
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

/** Regex that matches CR or LF characters — forbidden in HTTP header values. */
const CRLF_RE = /[\r\n]/;

/**
 * RFC 7230 §3.2.6 token regex — the only characters legal in an HTTP header
 * field-name.  Names that do not match are silently dropped by
 * {@link parseOtlpHeaders} so they never reach the `Headers` constructor
 * (which would throw `TypeError` and break the "never throws" contract of
 * {@link pushOtlpHttp}).
 */
const HEADER_NAME_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parse `AFK_OTLP_HEADERS` — a comma-separated `Key=Value` list — into a
 * plain object.  Malformed pairs (no `=`) are silently skipped.  Header names
 * or values containing CR/LF are silently skipped (injection guard).  Values
 * are `decodeURIComponent`-decoded so that a literal comma can be represented
 * as `%2C`; malformed percent sequences are left as-is (no unhandled throw).
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
    const rawValue = pair.slice(eq + 1).trim();
    if (!key) continue;
    if (CRLF_RE.test(key)) continue; // injection guard on name
    if (!HEADER_NAME_TOKEN_RE.test(key)) continue; // RFC 7230 token guard
    // Decode %2C (and other percent-sequences) safely; leave malformed as-is.
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }
    if (CRLF_RE.test(value)) continue; // injection guard on value
    result[key] = value;
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
 *
 * The endpoint must use `http:` or `https:`; any other scheme is rejected
 * immediately with `{ ok: false, error }` (no network call is made).
 *
 * `Content-Type: application/json` is always set and cannot be overridden by
 * `headers` — extra headers are applied first via `Headers`, then the
 * content-type is set unconditionally.
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

  // Validate endpoint scheme before making any network call.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    return { ok: false, error: `Invalid OTLP endpoint URL: ${endpoint}` };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      error: `OTLP endpoint must use http: or https: scheme, got: ${parsedUrl.protocol}`,
    };
  }

  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build headers inside try so a malformed extraHeaders key (e.g. one that
    // slipped past parseOtlpHeaders via programmatic `headers` option) causes
    // {ok:false} instead of an unhandled rejection.
    const headers = new Headers(extraHeaders);
    headers.set('Content-Type', 'application/json');

    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    // Capture status before cancelling the body — a cancel() rejection must
    // not lose the HTTP status that is already available.
    const { status, statusText, ok: httpOk } = response;
    try {
      await response.body?.cancel();
    } catch {
      // Body cancel failure is non-fatal; the status is already captured.
    }

    if (!httpOk) {
      return { ok: false, status, error: `HTTP ${status} ${statusText}` };
    }
    return { ok: true, status };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
