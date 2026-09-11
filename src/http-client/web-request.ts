/**
 * Core HTTP implementation for the `web_request` tool.
 *
 * Provides structured, SSRF-guarded HTTP requests supporting all standard
 * methods (GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE) with:
 *   - SSRF protection via `guardedFetch` (per-hop redirect validation)
 *   - Automatic retry only for idempotent methods (GET, HEAD, OPTIONS, PUT,
 *     DELETE); POST/PATCH are never auto-retried
 *   - Response body truncation to a configurable byte budget
 *   - JSON auto-parse when response Content-Type is application/json
 *   - Filtered response headers (no set-cookie, no x-* internals)
 *   - Timing measurement
 *
 * Risk classification (for callers / audit trails):
 *   GET / HEAD / OPTIONS → low
 *   POST / PUT / PATCH   → medium
 *   DELETE               → high
 *
 * Domain policy: callers may optionally pass a `domainCheck` to enforce
 * AFK_BROWSER_ALLOWED_DOMAINS / AFK_BROWSER_BLOCKED_DOMAINS in addition to
 * the SSRF guard. The SSRF guard always runs regardless.
 *
 * Effect ledger hook: when a `recordEffect` callback is supplied the call is
 * forwarded after the response is returned. The function is optional — callers
 * that don't supply it get no ledger write, so there is no hard dependency on
 * the ledger being present (it is built in parallel as #1412).
 *
 * @module web/web-request
 */

import { guardedFetch, checkEgressTarget, EgressBlockedError } from './egress-guard.js';
import type { EgressGuardOptions } from './egress-guard.js';
import type { FetchFn } from './types.js';
import { headAndTail } from '../agent/tools/handlers/_output-cap.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 100_000;
export const MAX_RESPONSE_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

/** HTTP method risk classification per the tool spec. */
export type MethodRisk = 'low' | 'medium' | 'high';

/** All supported HTTP methods (uppercase). */
export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const LOW_RISK_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'OPTIONS']);
const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export function classifyMethodRisk(method: HttpMethod): MethodRisk {
  if (LOW_RISK_METHODS.has(method)) return 'low';
  if (method === 'DELETE') return 'high';
  return 'medium';
}

export function isIdempotentMethod(method: HttpMethod): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// Response header filtering
// ---------------------------------------------------------------------------

/**
 * Headers suppressed from the structured response to avoid leaking
 * auth cookies, server internals, or implementation details.
 */
const SUPPRESSED_HEADER_PREFIXES = ['set-cookie', 'x-'];
const SUPPRESSED_HEADERS_EXACT = new Set([
  'server', 'via', 'age', 'vary',
  // Prevent OAuth/token-exchange responses that echo bearer tokens in headers
  // from leaking credentials into model context.
  'authorization', 'www-authenticate',
]);

function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (SUPPRESSED_HEADERS_EXACT.has(lower)) return;
    if (SUPPRESSED_HEADER_PREFIXES.some((p) => lower.startsWith(p))) return;
    out[key] = value;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Body serialisation
// ---------------------------------------------------------------------------

/**
 * Serialise the caller-supplied `body` field into a fetch-ready body string
 * and infer the Content-Type when not already present.
 * Returns `{ serialized, contentType }` where `contentType` is undefined
 * when the caller already set one in `headers`.
 */
function serializeBody(
  body: string | Record<string, unknown> | unknown[] | null | undefined,
  headers: Record<string, string>,
): { serialized: string | undefined; inferredContentType: string | undefined } {
  if (body === null || body === undefined) {
    return { serialized: undefined, inferredContentType: undefined };
  }
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'content-type',
  );
  if (typeof body === 'string') {
    return { serialized: body, inferredContentType: hasContentType ? undefined : 'text/plain' };
  }
  // object / array → JSON
  const serialized = JSON.stringify(body);
  return {
    serialized,
    inferredContentType: hasContentType ? undefined : 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Response body parsing
// ---------------------------------------------------------------------------

/**
 * Truncate a raw response body to `maxBytes` and auto-parse JSON when the
 * Content-Type header indicates it.
 */
function parseResponseBody(
  raw: string,
  contentType: string,
  maxBytes: number,
): { body: string | unknown; truncated: boolean } {
  const byteLen = Buffer.byteLength(raw, 'utf8');
  let bodyText = raw;
  let truncated = false;

  if (byteLen > maxBytes) {
    bodyText = headAndTail(raw, maxBytes);
    truncated = true;
  }

  // Auto-parse JSON (non-truncated only — partial JSON is not parseable)
  if (!truncated && /application\/json/i.test(contentType)) {
    try {
      return { body: JSON.parse(bodyText) as unknown, truncated: false };
    } catch {
      // Parse failure: return as text
    }
  }

  return { body: bodyText, truncated };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Structured result returned by {@link webRequest}. */
export interface WebRequestResult {
  status: number;
  /** Filtered response headers. */
  headers: Record<string, string>;
  /** Response body — auto-parsed JSON object or string. Truncated when `truncated` is true. */
  body: unknown;
  /** True when the response body was truncated to `maxResponseBytes`. */
  truncated: boolean;
  /** Wall-clock duration of the HTTP round trip, in milliseconds. */
  timing_ms: number;
  /** Risk level of the HTTP method used. */
  risk: MethodRisk;
}

/** Optional hook for recording the call in an effect ledger (#1412). */
export type RecordEffectFn = (entry: {
  url: string;
  method: HttpMethod;
  status: number;
  risk: MethodRisk;
  timing_ms: number;
}) => void | Promise<void>;

/** Domain policy check — same shape as `enforceDomainPolicy` from browser/config. */
export type DomainCheckFn = (
  url: string,
) => { allowed: true } | { allowed: false; reason: string };

export interface WebRequestOptions {
  url: string;
  method: HttpMethod;
  body?: string | Record<string, unknown> | unknown[] | null;
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  /** Abort signal — request is cancelled when this fires. Timeout is managed by the caller. */
  signal: AbortSignal;
  /** Override fetch for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
  /** DNS resolution override for tests (forwarded to the egress guard). */
  lookupFn?: EgressGuardOptions['lookupFn'];
  /**
   * Optional domain policy enforcer (AFK_BROWSER_ALLOWED_DOMAINS /
   * BLOCKED_DOMAINS). Runs IN ADDITION to the SSRF guard; a blocked domain
   * verdict causes an immediate error return, same as an SSRF block.
   */
  domainCheck?: DomainCheckFn;
  /**
   * Optional hook for recording the call in the effect ledger.
   * If absent the tool still works — no hard ledger dependency.
   */
  recordEffect?: RecordEffectFn;
}

/**
 * Make a structured, SSRF-guarded HTTP request.
 *
 * @throws {EgressBlockedError} when the target resolves to an internal address.
 *   Callers should catch this and surface a structured error ToolResult.
 * @throws {Error} on network-level failures. Caller surfaces as error ToolResult.
 * @throws when `signal` is already aborted or fires mid-request.
 */
export async function webRequest(opts: WebRequestOptions): Promise<WebRequestResult> {
  const {
    url,
    method,
    signal,
    domainCheck,
    recordEffect,
  } = opts;

  const maxResponseBytes = Math.min(
    opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
  );
  const headers: Record<string, string> = { ...opts.headers };
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const guardOpts: EgressGuardOptions = opts.lookupFn !== undefined
    ? { lookupFn: opts.lookupFn }
    : {};

  const risk = classifyMethodRisk(method);

  // -- Domain policy check (runs before SSRF guard to give a clearer error) --
  if (domainCheck !== undefined) {
    const verdict = domainCheck(url);
    if (!verdict.allowed) {
      throw Object.assign(new Error(`web_request blocked by domain policy: ${verdict.reason}`), {
        name: 'DomainPolicyError',
      });
    }
  }

  // -- SSRF pre-check ---------------------------------------------------------
  const egressVerdict = await checkEgressTarget(url, guardOpts);
  if (!egressVerdict.allowed) {
    throw new EgressBlockedError(egressVerdict.reason);
  }

  // -- Body serialisation -----------------------------------------------------
  const { serialized: rawBody, inferredContentType } = serializeBody(opts.body, headers);
  if (inferredContentType !== undefined) {
    headers['content-type'] = inferredContentType;
  }

  // -- Build fetch init -------------------------------------------------------
  const init: RequestInit = {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: rawBody,
    signal,
  };

  // -- Execute request (with optional retry for idempotent methods) -----------
  const idempotent = isIdempotentMethod(method);
  const retryOpts = idempotent
    ? { retries: 2, baseDelayMs: 300, maxDelayMs: 5_000 }
    : { retries: 0 }; // never auto-retry POST/PATCH

  const t0 = Date.now();

  let response: Response;
  try {
    // guardedFetch owns the redirect loop + SSRF re-check on each hop.
    response = await guardedFetch(fetchFn, url, init, {
      ...guardOpts,
      retry: retryOpts,
    });
  } catch (err) {
    // EgressBlockedError surfaces cleanly — re-throw as-is for the handler.
    if (err instanceof EgressBlockedError) throw err;
    throw err;
  }

  const timing_ms = Date.now() - t0;
  const responseContentType = response.headers.get('content-type') ?? '';

  let rawBodyText: string;
  try {
    // Stream the response body up to 2× maxResponseBytes before the downstream
    // truncation logic runs. This prevents an untrusted endpoint from forcing
    // the process to buffer an arbitrarily large response body via response.text().
    const reader = response.body?.getReader();
    if (!reader) {
      rawBodyText = '';
    } else {
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const byteLimit = maxResponseBytes * 2;
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        totalBytes += value.byteLength;
        if (totalBytes >= byteLimit) {
          await reader.cancel();
          break;
        }
      }
      rawBodyText = new TextDecoder().decode(
        Buffer.concat(chunks, totalBytes),
      );
    }
  } catch {
    rawBodyText = '';
  }

  const { body, truncated } = parseResponseBody(rawBodyText, responseContentType, maxResponseBytes);
  const filteredHeaders = filterResponseHeaders(response.headers);

  // -- Effect ledger (fire-and-forget; no hard dependency) --------------------
  if (recordEffect !== undefined) {
    void Promise.resolve(
      recordEffect({ url, method, status: response.status, risk, timing_ms }),
    ).catch(() => undefined);
  }

  return {
    status: response.status,
    headers: filteredHeaders,
    body,
    truncated,
    timing_ms,
    risk,
  };
}

/**
 * Validate and normalise a raw `method` string to an uppercase `HttpMethod`.
 * Returns `{ error }` when the method is not supported.
 */
export function parseMethod(raw: unknown): HttpMethod | { error: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: 'method must be a non-empty string (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)' };
  }
  const upper = raw.trim().toUpperCase() as HttpMethod;
  const SUPPORTED: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  if (!SUPPORTED.includes(upper)) {
    return {
      error: `method "${raw}" is not supported — must be one of: ${SUPPORTED.join(', ')}`,
    };
  }
  return upper;
}
