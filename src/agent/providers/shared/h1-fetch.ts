/**
 * HTTP/1.1-only fetch for model provider calls.
 *
 * History: On 2026-10-08 two REPL processes froze at ~100% CPU with their
 * main thread stuck in an infinite nghttp2 DATA-frame send loop
 * (uv__run_check → Http2Session::SendPendingData → nghttp2_session_pack_data →
 * Http2Stream::Provider::Stream::OnRead) against api.anthropic.com.  One
 * process reached 232 GB compressed before macOS killed it; the other hit
 * 78 GB.  The freeze is intermittent (~2 of ~17 live sessions were affected)
 * and appears to be triggered by a server-side or nghttp2 state where the
 * DATA callback spins without ever terminating.  No JS runs while the loop is
 * active, so the UI becomes unresponsive and the process never recovers.
 *
 * Root-cause chain:
 *   1. undici 8 changed `allowH2` to default `true` (nodejs/undici PR #4828).
 *   2. agent-afk depends on npm `undici ^8.11.2` (required by jsdom 30).
 *   3. Importing npm undici — or jsdom, which does so internally — writes its
 *      `Agent` (with h2 enabled) into the process-wide global-dispatcher slot
 *      `globalThis[Symbol.for('undici.globalDispatcher.2')]` with
 *      `configurable: false`.  See issue #2528 for the full measurement table.
 *   4. Node 26's built-in `fetch` (which is also undici 8.11.2) reads the
 *      same global slot for every request, so ALL `fetch()` calls — including
 *      those made by the Anthropic and OpenAI SDK clients — dispatch through
 *      the h2-enabled Agent and can negotiate HTTP/2 with api.anthropic.com.
 *   5. Negotiating HTTP/2 exposes the process to the spinning DATA-frame
 *      freeze on Node ≥ 26.
 *
 * Fix: give SDK clients an explicit `fetch` built on npm undici's own `fetch`
 * function with a dedicated `Agent` that has `allowH2: false`.  Because each
 * request explicitly passes `dispatcher: h1Agent` in the RequestInit, the
 * call bypasses the global-dispatcher slot entirely — regardless of what jsdom
 * or any other importer has stored there — and forces HTTP/1.1 for every
 * model API call.
 *
 * This module is the single authoritative source of that fetch.  Both
 * providers (anthropic-direct, openai-compatible) and the usage-polling path
 * import it.  The SSRF/egress-guard logic in egress-guard.ts is unaffected:
 * it uses its own dispatcher for the per-request DNS connect-time check.
 *
 * Invariant: this module must not read `process.env` directly.  All
 * env-reading must go through `src/config/env.ts`.
 *
 * @module agent/providers/shared/h1-fetch
 */

import { Agent, fetch as undiciFetch } from 'undici';

/**
 * A shared undici `Agent` with `allowH2: false`.  Module-scope singleton so
 * the connection pool is reused across all model API calls in a single
 * process, preserving HTTP/1.1 keep-alive benefits (TLS session reuse,
 * multiplexed pipelining within one connection) while ruling out HTTP/2.
 *
 * Invariant: this Agent must never be passed to `globalThis.fetch` as a
 * `dispatcher` from within the egress-guard or web-scrape paths.  Those paths
 * carry their OWN Agent with a connect-time DNS lookup that enforces the SSRF
 * guard; mixing the two Agents would silently drop that guard.
 */
const h1Agent = new Agent({ allowH2: false });

/**
 * A `fetch`-compatible function that forces HTTP/1.1 on every request by
 * using npm undici's own `fetch` with the shared {@link h1Agent} as the
 * dispatcher.
 *
 * Contract:
 * - Same signature as the global `fetch`.
 * - Always negotiates HTTP/1.1 (TLS ALPN `http/1.1`), even on Node 26 where
 *   the global dispatcher may have h2 enabled via jsdom's undici import.
 * - Compatible with Node 22, 24, and 26.
 * - The `dispatcher` field in `init` is ALWAYS overwritten with `h1Agent`;
 *   a caller-supplied dispatcher is silently discarded.  If the SDK or any
 *   wrapper adds a dispatcher, it will be replaced.  This is intentional:
 *   the entire point is to force a known, controlled dispatcher.
 */
export const h1ModelFetch: typeof fetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  // Invariant: `dispatcher` is set unconditionally, overriding any value the
  // SDK or a wrapping fetch may have injected.  The casts to `unknown` then
  // `Promise<Response>` are required for two reasons:
  //   1. The built-in `RequestInit` type does not expose `dispatcher` — it is
  //      an undici extension not yet part of the WHATWG fetch spec.
  //   2. undici exports its own `Response` type that is structurally slightly
  //      different from Node's built-in `Response` (e.g. headers iterator
  //      shape), so a direct cast `as Promise<Response>` fails strict tsc.
  //      Going through `unknown` is the correct double-assertion pattern when
  //      the runtime object is compatible but the types diverge (per TypeScript
  //      docs on type assertions).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return undiciFetch(input as any, { ...(init as any), dispatcher: h1Agent }) as unknown as Promise<Response>;
};
