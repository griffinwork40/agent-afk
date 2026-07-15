/**
 * Provider-agnostic `Retry-After` header parsing.
 *
 * HTTP backoff-hint parsing has nothing provider-specific about it: both the
 * Anthropic and OpenAI SDKs surface a thrown `APIError` carrying the response
 * `headers`, and both honor the standard `retry-after` (and OpenAI's
 * `retry-after-ms`) convention. These helpers were originally defined inside
 * `anthropic-direct/usage-limit.ts`; they were lifted here so the
 * `openai-compatible` retry path can honor the same hint without importing
 * across the provider boundary or duplicating the parse. `usage-limit.ts`
 * re-exports both names, so its existing public surface is unchanged.
 *
 * @module agent/providers/shared/retry-after
 */

/**
 * Defensive read of a single HTTP header off an error's `headers` field.
 *
 * SDK `APIError.headers` has been both a web `Headers` (with `.get`) and a
 * plain record across versions and across the Anthropic/OpenAI SDKs, so both
 * shapes are handled: a `.get()` method is preferred, else the record is probed
 * for the exact key and its upper-cased form. Returns the header value, or
 * `undefined` when the error is not an object, has no usable `headers`, or the
 * header is absent.
 */
export function getHeader(error: unknown, name: string): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (headers === null || headers === undefined) return undefined;
  const h = headers as { get?: unknown };
  if (typeof h.get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name);
    return v ?? undefined;
  }
  if (typeof headers === 'object') {
    const rec = headers as Record<string, unknown>;
    const v = rec[name] ?? rec[name.toUpperCase()];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Best-effort parse of a transient-backoff hint from an error's HTTP headers.
 *
 * Reads `retry-after-ms` (milliseconds) first, then `retry-after` (seconds, or
 * an HTTP-date). Returns the delay in ms, or `undefined` when no usable header
 * is present. Header access is via the shared {@link getHeader} helper, which
 * handles both a web `Headers` (with `.get`) and a plain-record shape.
 */
export function parseRetryAfterMs(error: unknown): number | undefined {
  const ms = getHeader(error, 'retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const sec = getHeader(error, 'retry-after');
  if (sec !== undefined) {
    const n = Number(sec);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
    const dateMs = Date.parse(sec);
    if (!Number.isNaN(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta >= 0) return delta;
    }
  }
  return undefined;
}
