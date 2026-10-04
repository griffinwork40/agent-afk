/**
 * OpenAI client construction for the openai-compatible provider, plus the
 * test-injection factory hook and the rate-limit admission fetch builder.
 * Extracted from `query.ts` so the query module carries only the session class
 * and its turn loop.
 *
 * @module agent/providers/openai-compatible/query/client
 */

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { getRateLimitBucket } from '../../shared/rate-limit-bucket.registry.js';
import { parseOpenAIRateLimitHeaders } from '../../shared/rate-limit-headers.js';
import { perMinuteFromRateLimit, publishingGate, publishUsage } from '../../../usage/usage-ledger.js';
import { makeOpenAITracingFetch } from '../tracing-fetch.js';

/**
 * Test injection hook for the OpenAI client. Set to a factory to swap in a
 * mock client; pass `null` to restore the real constructor. Not part of the
 * stable surface — tests reach into this module (re-exported via `query.ts`)
 * directly.
 */
export type OpenAIClientFactory = (opts: {
  apiKey: string;
  baseURL?: string;
  /** Extra default headers (e.g. xAI CLI-proxy identity). Merged by callers. */
  defaultHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}) => OpenAI;

let clientFactory: OpenAIClientFactory | null = null;

export function __setOpenAIClientFactory(factory: OpenAIClientFactory | null): void {
  clientFactory = factory;
}

function defaultClientFactory(opts: {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}): OpenAI {
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: opts.apiKey,
    // Disable SDK-level retries so AFK's own retry loop (retry.ts
    // MAX_CONNECTION_RETRIES / MAX_STREAM_RETRIES) is the single, traced
    // retry authority. Without this the SDK default of 2 silently runs under
    // AFK's loop, turning a single failing request into up to 3× the
    // attempts AFK believes it is making — and those SDK-level retries are
    // invisible in the witness trace (issue #2422).
    maxRetries: 0,
  };
  if (opts.baseURL !== undefined) clientOpts.baseURL = opts.baseURL;
  if (opts.defaultHeaders !== undefined) clientOpts.defaultHeaders = opts.defaultHeaders;
  if (opts.fetch !== undefined) clientOpts.fetch = opts.fetch;
  return new OpenAI(clientOpts);
}

/**
 * Return the active client factory: the test-injected one when set, else the
 * real `new OpenAI(...)` constructor. Encapsulates the mutable injection state
 * so callers never read the module global directly.
 */
export function resolveClientFactory(): OpenAIClientFactory {
  return clientFactory ?? defaultClientFactory;
}

/**
 * Hostnames (exact) and hostname suffixes that bypass the rate-limit admission
 * gate. Exact entries are matched as-is; suffix entries (starting with '.')
 * match the hostname or any subdomain.
 * Includes IPv4/IPv6 loopback, any-address, and the ChatGPT-OAuth backend
 * (subscription pass-through — no per-minute rate limits apply there).
 */
const LOCAL_EXACT = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'chatgpt.com']);
const LOCAL_SUFFIXES = ['.chatgpt.com'];

function isLocalEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    // Malformed URL — fall through to admission gating (safe default).
    return false;
  }
  if (LOCAL_EXACT.has(hostname)) return true;
  if (hostname.startsWith('127.')) return true;
  return LOCAL_SUFFIXES.some((s) => hostname === s.slice(1) || hostname.endsWith(s));
}

/**
 * Build a rate-limit admission fetch wrapper for the OpenAI SDK.
 * Returns `undefined` for local-shim endpoints (no meaningful rate limits there).
 * See `rate-limit-bucket.ts` and `rate-limit-headers.ts` for the bucket details.
 */
export function buildOpenAIAdmissionFetch(baseURL: string | undefined): typeof fetch | undefined {
  if (isLocalEndpoint(baseURL)) return undefined;
  // Usage-ledger account: the endpoint host, so distinct OpenAI-compatible
  // backends never merge. The ChatGPT/Codex subscription backend emits no
  // x-ratelimit-* headers, so it never produces a record (usage unknown).
  const account = ledgerAccountForBaseUrl(baseURL);
  // Admission bucket keyed the same way, so each backend gates on its own
  // headers and adopts peer processes' freezes for that backend only.
  const bucket = getRateLimitBucket('openai', account);
  const rateLimitObserver = (headers: Headers): void => {
    const snapshot = parseOpenAIRateLimitHeaders(headers);
    if (snapshot === undefined) return;
    bucket.update(snapshot);
    publishUsage({ v: 1, provider: 'openai', account, perMinute: perMinuteFromRateLimit(snapshot, Date.now()) });
  };
  const gate = publishingGate(bucket, 'openai', account);
  return makeOpenAITracingFetch(globalThis.fetch, undefined, rateLimitObserver, gate);
}

/**
 * Derive a ledger/bucket key from a baseURL. Parseable URLs use the hostname
 * (unchanged from before — persisted ledger data stays continuous). Unparseable
 * URLs get a short SHA-256 hash prefix so each distinct endpoint gets its own
 * rate-limit bucket and ledger row. The raw URL is never stored: it may contain
 * credentials or query-string tokens.
 */
export function ledgerAccountForBaseUrl(baseURL: string | undefined): string {
  if (baseURL === undefined) return 'api.openai.com';
  try {
    return new URL(baseURL).hostname;
  } catch {
    return `custom-${createHash('sha256').update(baseURL).digest('hex').slice(0, 12)}`;
  }
}
