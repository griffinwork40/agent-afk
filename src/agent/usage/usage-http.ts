/**
 * Shared GET-JSON transport for subscription usage endpoints (Claude OAuth
 * `api/oauth/usage`, ChatGPT `backend-api/wham/usage`). One timeout policy,
 * one error taxonomy, one body-leak rule for every usage fetcher.
 *
 * Contract: never surface response body text in a failure `detail`; it may
 * carry credentials or PII from an error page. Status code and a generic
 * phrase only. The detail strings are the historical ones from
 * `subscription-usage.ts` and are asserted by its tests.
 *
 * @module agent/usage/usage-http
 */

import type { UsageUnavailable } from '../subscription-usage.js';
import { h1ModelFetch } from '../providers/shared/h1-fetch.js';

export const DEFAULT_USAGE_TIMEOUT_MS = 10_000;

/** Reject epoch-seconds values outside a sane [1970, 2100) range. */
export const MAX_REASONABLE_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

/** Clamp a utilization fraction to [0, 1]. */
export function clampFraction(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export interface UsageHttpOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface UsageJson {
  readonly kind: 'json';
  readonly body: Record<string, unknown>;
}

function isAbortOrTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** GET `url` and return its JSON object body, or a classified failure. Never throws. */
export async function fetchUsageJson(
  url: string,
  headers: Record<string, string>,
  options: UsageHttpOptions = {},
): Promise<UsageJson | UsageUnavailable> {
  const fetchImpl = options.fetchImpl ?? h1ModelFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return isAbortOrTimeoutError(err)
      ? { kind: 'unavailable', reason: 'timeout', detail: 'Request to the usage endpoint timed out.' }
      : { kind: 'unavailable', reason: 'network-error', detail: 'Network error while contacting the usage endpoint.' };
  }
  if (!response.ok) {
    return { kind: 'unavailable', reason: 'http-error', detail: `Usage endpoint returned HTTP ${response.status}.` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: 'unavailable',
      reason: 'malformed-response',
      detail: 'Usage endpoint returned a response that was not valid JSON.',
    };
  }
  if (typeof body !== 'object' || body === null) {
    return {
      kind: 'unavailable',
      reason: 'malformed-response',
      detail: 'Usage endpoint returned an unexpected response shape.',
    };
  }
  return { kind: 'json', body: body as Record<string, unknown> };
}
