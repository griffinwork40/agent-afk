/**
 * Handler for the `web_request` tool.
 *
 * Provides structured, SSRF-guarded HTTP requests for all methods:
 *   GET / HEAD / OPTIONS — low risk, idempotent (auto-retried on transient failures)
 *   POST / PUT / PATCH   — medium risk, only PUT is idempotent (POST/PATCH never retried)
 *   DELETE               — high risk, idempotent
 *
 * Safety layers (in application order):
 *   1. Input validation — URL, method, timeout, body, headers
 *   2. Domain policy — AFK_BROWSER_ALLOWED_DOMAINS / BLOCKED_DOMAINS (when set)
 *   3. SSRF guard — DNS-resolved IP classification, per-hop redirect validation
 *   4. Response truncation — max_response_bytes (default 100KB, ceiling 1MB)
 *   5. Secret redaction — Authorization header, known token patterns
 *
 * Credential injection: pass `credential: "<ENV_VAR_NAME>"` to resolve an
 * environment variable at runtime and inject it as a Bearer token in the
 * Authorization header. The raw value is never logged or returned.
 *
 * Effect ledger hook: if `opts.recordEffect` is provided, it is called after a
 * successful response. The handler does NOT hard-depend on the ledger (#1412).
 *
 * @module agent/tools/handlers/web-request
 */

import type { ToolHandler } from '../types.js';
import {
  webRequest,
  parseMethod,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES,
  type WebRequestOptions,
  type RecordEffectFn,
  type DomainCheckFn,
} from '../../../web/web-request.js';
import { EgressBlockedError } from '../../../web/egress-guard.js';
import type { EgressGuardOptions } from '../../../web/egress-guard.js';
import { redactSecrets } from '../../redact-secrets.js';

type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface ParsedInput {
  url: string;
  method: ReturnType<typeof parseMethod> extends infer R
    ? R extends { error: string }
      ? never
      : R
    : never;
  body: string | Record<string, unknown> | unknown[] | null | undefined;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  credential: string | undefined;
}

function parseInput(raw: unknown): ParsedInput | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Invalid input: expected an object' };
  }
  const obj = raw as Record<string, unknown>;

  // url
  if (typeof obj['url'] !== 'string' || obj['url'].length === 0) {
    return { error: 'Invalid input: "url" must be a non-empty string' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(obj['url']);
  } catch {
    return { error: `Invalid input: "${obj['url']}" is not a valid absolute URL` };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      error: `Invalid input: protocol "${parsedUrl.protocol}" not supported (http/https only)`,
    };
  }
  // Strip userinfo (user:password@host) so it is not written to the effect
  // ledger or forwarded anywhere it could leak credentials.
  parsedUrl.username = '';
  parsedUrl.password = '';
  const url = parsedUrl.toString();

  // method
  const methodResult = parseMethod(obj['method']);
  if (typeof methodResult === 'object' && 'error' in methodResult) {
    return { error: `Invalid input: ${methodResult.error}` };
  }
  const method = methodResult;

  // body — string, object, or absent
  let body: string | Record<string, unknown> | unknown[] | null | undefined;
  if (obj['body'] !== undefined && obj['body'] !== null) {
    if (
      typeof obj['body'] !== 'string' &&
      typeof obj['body'] !== 'object'
    ) {
      return { error: 'Invalid input: "body" must be a string, object, or array' };
    }
    body = obj['body'] as string | Record<string, unknown> | unknown[];
  }

  // headers — optional Record<string, string>
  let headers: Record<string, string> = {};
  if (obj['headers'] !== undefined) {
    if (typeof obj['headers'] !== 'object' || obj['headers'] === null || Array.isArray(obj['headers'])) {
      return { error: 'Invalid input: "headers" must be a string-keyed object' };
    }
    const headersRaw = obj['headers'] as Record<string, unknown>;
    for (const [k, v] of Object.entries(headersRaw)) {
      if (typeof v !== 'string') {
        return { error: `Invalid input: header value for "${k}" must be a string` };
      }
      headers[k] = v;
    }
  }

  // timeout_ms
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj['timeout_ms'] !== undefined) {
    if (
      typeof obj['timeout_ms'] !== 'number' ||
      !Number.isFinite(obj['timeout_ms']) ||
      obj['timeout_ms'] <= 0
    ) {
      return { error: 'Invalid input: "timeout_ms" must be a positive finite number' };
    }
    timeoutMs = Math.min(obj['timeout_ms'], MAX_TIMEOUT_MS);
  }

  // max_response_bytes
  let maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES;
  if (obj['max_response_bytes'] !== undefined) {
    if (
      typeof obj['max_response_bytes'] !== 'number' ||
      !Number.isFinite(obj['max_response_bytes']) ||
      obj['max_response_bytes'] <= 0
    ) {
      return { error: 'Invalid input: "max_response_bytes" must be a positive finite number' };
    }
    maxResponseBytes = Math.min(obj['max_response_bytes'], MAX_RESPONSE_BYTES);
  }

  // credential — optional env var name
  let credential: string | undefined;
  if (obj['credential'] !== undefined) {
    if (typeof obj['credential'] !== 'string' || obj['credential'].length === 0) {
      return { error: 'Invalid input: "credential" must be a non-empty string (an env var name)' };
    }
    credential = obj['credential'];
  }

  return { url, method, body, headers, timeoutMs, maxResponseBytes, credential };
}

// ---------------------------------------------------------------------------
// Handler options
// ---------------------------------------------------------------------------

export interface WebRequestHandlerOptions {
  /** Override fetch for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
  /** DNS resolution override for tests. */
  lookupFn?: EgressGuardOptions['lookupFn'];
  /** Environment variable source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional domain policy enforcer. When set, checked before the SSRF guard.
   * Allows AFK_BROWSER_ALLOWED_DOMAINS / BLOCKED_DOMAINS to apply to web_request
   * as well as browser tools.
   */
  domainCheck?: DomainCheckFn;
  /** Optional effect ledger hook (see #1412). */
  recordEffect?: RecordEffectFn;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebRequestHandler(opts: WebRequestHandlerOptions = {}): ToolHandler {
  const fetchFn: FetchFn = opts.fetchFn ?? globalThis.fetch;
  const envSource: NodeJS.ProcessEnv = opts.env ?? process.env;

  // Lazily resolve the domain policy enforcer so AFK_BROWSER_ALLOWED_DOMAINS /
  // AFK_BROWSER_BLOCKED_DOMAINS apply to web_request without requiring the
  // caller to thread BrowserConfig through createBuiltinHandlers.
  // When opts.domainCheck is supplied (e.g. in tests), it takes precedence.
  async function resolveDomainCheck(): Promise<DomainCheckFn | undefined> {
    if (opts.domainCheck !== undefined) return opts.domainCheck;
    try {
      const { loadBrowserConfig, enforceDomainPolicy } = await import('../../../browser/config.js');
      const config = loadBrowserConfig();
      return (url: string) => enforceDomainPolicy(url, config);
    } catch {
      return undefined;
    }
  }

  return async (input, signal) => {
    if (typeof fetchFn !== 'function') {
      return {
        content:
          'web_request unavailable: global fetch() is not present ' +
          '(agent-afk requires Node 20+).',
        isError: true,
      };
    }

    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    // Pre-aborted short-circuit
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `web_request aborted: ${msg}`, isError: true };
    }

    // -- Credential resolution -----------------------------------------------
    // Resolve the env var before building the AbortController so a missing
    // var is a clean synchronous error, not a partially-started request.
    const headers = { ...parsed.headers };
    if (parsed.credential !== undefined) {
      const token = envSource[parsed.credential];
      if (token === undefined || token.trim().length === 0) {
        return {
          content:
            `web_request credential error: environment variable "${parsed.credential}" is not set. ` +
            `Set it in afk.env or export it in the shell before starting AFK.`,
          isError: true,
        };
      }
      // Explicit error when caller supplies both credential and Authorization header —
      // silently discarding the credential would be confusing and error-prone.
      const hasAuth = Object.keys(headers).some(
        (k) => k.toLowerCase() === 'authorization',
      );
      if (hasAuth) {
        return {
          content:
            'web_request credential error: both "credential" and an explicit Authorization header were provided. Use one or the other.',
          isError: true,
        };
      }
      headers['Authorization'] = `Bearer ${token}`;
    }

    // -- Abort controller with timeout ---------------------------------------
    const ac = new AbortController();
    const onParentAbort = (): void => ac.abort(signal.reason);

    let timer: ReturnType<typeof setTimeout> | undefined;

    const abortMessage = (): string => {
      const reason = ac.signal.reason;
      return reason instanceof Error ? reason.message : String(reason ?? 'aborted');
    };

    try {
      signal.addEventListener('abort', onParentAbort, { once: true });
      timer = setTimeout(() => {
        ac.abort(new Error(`web_request timeout after ${parsed.timeoutMs}ms`));
      }, parsed.timeoutMs);

      // -- Core request -------------------------------------------------------
      // Resolve domain policy lazily so env-var-driven domain restrictions
      // (AFK_BROWSER_ALLOWED_DOMAINS / BLOCKED_DOMAINS) take effect even when
      // the caller creates the handler with no opts (production default path).
      const domainCheck = await resolveDomainCheck();
      const requestOpts: WebRequestOptions = {
        url: parsed.url,
        method: parsed.method,
        body: parsed.body,
        headers,
        maxResponseBytes: parsed.maxResponseBytes,
        signal: ac.signal,
        fetchFn,
        lookupFn: opts.lookupFn,
        domainCheck,
        recordEffect: opts.recordEffect,
      };

      let result;
      try {
        result = await webRequest(requestOpts);
      } catch (err) {
        if (ac.signal.aborted) {
          return { content: `web_request aborted: ${abortMessage()}`, isError: true };
        }
        if (err instanceof EgressBlockedError) {
          return { content: `web_request blocked: ${err.message}`, isError: true };
        }
        const name = err instanceof Error && err.name === 'DomainPolicyError' ? 'blocked' : 'network error';
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `web_request ${name}: ${msg}`, isError: true };
      }

      if (ac.signal.aborted) {
        return { content: `web_request aborted: ${abortMessage()}`, isError: true };
      }

      // -- Format structured response ----------------------------------------
      // Redact secrets from response body before returning to model context.
      // JSON responses are parsed objects — serialize, redact, then re-parse so
      // token patterns embedded in JSON values (e.g. {"key":"sk-ant-…"}) are masked.
      let responseBody = result.body;
      if (typeof responseBody === 'string') {
        responseBody = redactSecrets(responseBody);
      } else if (typeof responseBody === 'object' && responseBody !== null) {
        const serialized = redactSecrets(JSON.stringify(responseBody));
        try { responseBody = JSON.parse(serialized); } catch { responseBody = serialized; }
      }

      const output = {
        status: result.status,
        headers: result.headers,
        body: responseBody,
        timing_ms: result.timing_ms,
        ...(result.truncated ? { truncated: true } : {}),
      };

      const content = JSON.stringify(output, null, 2);
      return {
        content,
        ...(result.truncated ? { truncated: true } : {}),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }
  };
}

export const webRequestHandler: ToolHandler = createWebRequestHandler();
