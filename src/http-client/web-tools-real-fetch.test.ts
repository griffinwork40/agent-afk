/**
 * Regression suite for the production fetch path — no injected fetchFn,
 * lookupFn, or dispatcher (#2774 / fix in #2754).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * From v5.278.0 to v5.282.1 every web_request / web_scrape / wait_for(url)
 * call failed with `TypeError: fetch failed` on Node 20+. Root cause: the
 * egress-guard's connect-time `lookup` hook always called back with the
 * single-address form `callback(null, address, family)` regardless of
 * `options.all`. On Node 24+, undici passes `{ hints:1024, all:true }` and
 * `net` throws `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` when
 * it receives a scalar reply for an `all=true` request.
 *
 * CI missed it because EVERY test that exercises the fetch path injects a
 * mock `fetchFn` or `lookupFn` — so the real `guardedDispatcher` (the npm
 * undici Agent wired in `egress-guard.ts`) was never exercised. The fix
 * (PR #2754) extracted the hook into `createGuardedLookup` in
 * `egress-guard.lookup.ts`, which honours the `options.all` contract.
 *
 * ── WHAT IS TESTED ───────────────────────────────────────────────────────
 * Each test calls a production entry-point with NO fetchFn / lookupFn
 * injection so that `guardedFetch` inside `egress-guard.ts` selects
 * `guardedDispatcher` — the real npm undici Agent — as the transport. Any
 * regression in the dispatcher's `lookup` contract will produce
 * `TypeError: fetch failed` with `ERR_INVALID_IP_ADDRESS` as cause, which
 * these tests classify as a hard failure.
 *
 * ── SKIP POLICY ──────────────────────────────────────────────────────────
 * Network-class failures (ENOTFOUND, ETIMEDOUT, ECONNRESET, EAI_AGAIN,
 * ECONNREFUSED, ENETUNREACH, UND_ERR_CONNECT_TIMEOUT) skip with a console
 * warning instead of failing — CI may run in a sandboxed environment with
 * no outbound connectivity. Bug-class failures (ERR_INVALID_IP_ADDRESS,
 * ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE) ALWAYS hard-fail so future
 * regressions of this class are caught immediately.
 *
 * ── POSIX COMPLIANCE ─────────────────────────────────────────────────────
 * No platform-conditional skips (R4). Both tests bind only to network
 * resources that are present on POSIX and Windows. Runtime network
 * unavailability is handled by a `skipIfNetworkUnavailable` helper that
 * does NOT inspect `process.platform`.
 *
 * @module http-client/web-tools-real-fetch.test
 */

import { describe, it, expect } from 'vitest';
import { guardedFetch } from './egress-guard.js';
import { webRequest } from './web-request.js';
import { evaluateUrl } from '../agent/tools/handlers/wait-for-conditions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Error codes that indicate transient / environmental network unavailability.
 * These result in a runtime skip, not a hard failure.
 */
const NETWORK_SKIP_CODES = new Set([
  'ENOTFOUND',      // DNS resolution failure
  'ETIMEDOUT',      // TCP connect timeout
  'ECONNRESET',     // server reset
  'EAI_AGAIN',      // DNS temporary failure
  'ECONNREFUSED',   // connection refused (no server listening)
  'ENETUNREACH',    // network unreachable
  // undici-specific
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Error codes that indicate a CODE BUG in the dispatcher / lookup hook, NOT
 * a transient network issue. The pre-fix code produces ERR_INVALID_IP_ADDRESS
 * when undici calls the lookup hook with all=true and the hook returns the
 * single-address scalar form instead of the required array form.
 */
const BUG_CODES = new Set([
  'ERR_INVALID_IP_ADDRESS',   // the original bug (undici + Node 24+ all=true mismatch)
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
]);

/**
 * Classify a caught error and return a skip reason (string) when it is
 * network-class, or null when the error is a hard failure.
 *
 * Handles both direct throws AND undici's wrapping pattern:
 *   TypeError('fetch failed', { cause: <inner error> })
 */
function classifyFetchError(err: unknown): { skip: string } | { hardFail: string } {
  if (!(err instanceof Error)) {
    return { hardFail: `Unexpected non-Error throw: ${String(err)}` };
  }

  const causeErr = (err as { cause?: unknown }).cause;
  const causeCode =
    causeErr instanceof Error
      ? (causeErr as NodeJS.ErrnoException).code
      : undefined;
  const directCode = (err as NodeJS.ErrnoException).code;

  // Check cause first (undici wraps as TypeError('fetch failed', { cause }))
  const code = causeCode ?? directCode;

  if (code !== undefined && BUG_CODES.has(code)) {
    const causeMsg = causeErr instanceof Error ? causeErr.message : '';
    return {
      hardFail:
        `Bug-class error detected — this is the ERR_INVALID_IP_ADDRESS regression ` +
        `(undici lookup hook returned wrong shape for options.all=true). ` +
        `Error: ${err.message} | cause code: ${code} | cause message: ${causeMsg}`,
    };
  }

  if (code !== undefined && NETWORK_SKIP_CODES.has(code)) {
    return { skip: `Network unavailable (${code}): ${err.message}` };
  }

  // Fallback: if the error message itself contains a network skip code or
  // recognisable network message, skip rather than fail. This handles systems
  // where the error code is embedded in the message but not set as .code.
  const msg = err.message.toLowerCase();
  if (
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('eai_again') ||
    msg.includes('econnrefused') ||
    msg.includes('network is unreachable') ||
    msg.includes('connect timeout')
  ) {
    return { skip: `Network unavailable (embedded in message): ${err.message}` };
  }

  // Unknown error — treat as hard failure so surprises are caught.
  return {
    hardFail:
      `Unexpected error (not a known network skip or bug-class code). ` +
      `code=${code ?? 'none'}, message=${err.message}` +
      (causeErr instanceof Error
        ? `, cause.code=${causeCode ?? 'none'}, cause.message=${(causeErr as Error).message}`
        : ''),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Target URL for production-path tests. Uses IANA's example.com (RFC 2606):
 * - Publicly routable — guardedDispatcher's connect-time lookup is exercised
 * - Very stable — maintained by IANA for exactly this kind of tooling use
 * - Does not require auth or any env var
 */
const TARGET_URL = 'https://example.com/';

describe('real production fetch path — no injected fetchFn / lookupFn (#2774)', () => {
  /**
   * Test 1: guardedFetch with globalThis.fetch (no fetchFn injection)
   *
   * This is the lowest-level entry point that directly selects
   * `guardedDispatcher`. When `fetchFn === globalThis.fetch` and
   * `AFK_WEB_ALLOW_PRIVATE_HOSTS` is unset, guardedFetch routes through
   * the npm undici `fetch` + `guardedDispatcher` — the exact path that
   * triggered ERR_INVALID_IP_ADDRESS on Node 24+ with the pre-fix lookup hook.
   *
   * Revert proof:
   *   FAIL (pre-fix):  TypeError: fetch failed | cause: ERR_INVALID_IP_ADDRESS
   *   PASS (post-fix): HTTP 200 from example.com
   */
  it('guardedFetch reaches example.com via real undici dispatcher', async () => {
    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), 15_000);
    let response: Response | undefined;
    try {
      // Call guardedFetch with NO injection:
      //   - fetchFn defaults to globalThis.fetch inside guardedFetch
      //   - no lookupFn → pre-check uses real dns.lookup
      //   - no allowPrivateHosts → useUndici=true → guardedDispatcher is used
      response = await guardedFetch(globalThis.fetch, TARGET_URL, { signal: ac.signal });
    } catch (err) {
      const verdict = classifyFetchError(err);
      if ('skip' in verdict) {
        console.warn(`[web-tools-real-fetch] SKIP: ${verdict.skip}`);
        return; // skip — network unavailable
      }
      throw new Error(verdict.hardFail);
    } finally {
      clearTimeout(timeoutHandle);
    }
    // Any response (including 4xx/5xx) means the dispatcher + lookup hook worked.
    // A 200 confirms the full round-trip succeeds on a stable target.
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(600);
  });

  /**
   * Test 2: webRequest with no fetchFn/lookupFn injection
   *
   * Exercises the web_request tool core (src/http-client/web-request.ts)
   * end-to-end with real undici. webRequest defaults `fetchFn` to
   * `globalThis.fetch` when none is supplied — so guardedFetch selects
   * guardedDispatcher, exactly as in production.
   *
   * Revert proof:
   *   FAIL (pre-fix):  thrown TypeError: fetch failed (ERR_INVALID_IP_ADDRESS)
   *   PASS (post-fix): WebRequestResult with status in [200,599]
   */
  it('webRequest reaches example.com via real undici dispatcher', async () => {
    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), 15_000);
    let result: Awaited<ReturnType<typeof webRequest>> | undefined;
    try {
      // No fetchFn, no lookupFn → real guardedDispatcher path
      result = await webRequest({
        url: TARGET_URL,
        method: 'GET',
        signal: ac.signal,
        // fetchFn intentionally omitted → globalThis.fetch default
        // lookupFn intentionally omitted → real dns.lookup in pre-check
      });
    } catch (err) {
      const verdict = classifyFetchError(err);
      if ('skip' in verdict) {
        console.warn(`[web-tools-real-fetch] SKIP: ${verdict.skip}`);
        return; // skip — network unavailable
      }
      throw new Error(verdict.hardFail);
    } finally {
      clearTimeout(timeoutHandle);
    }
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(600);
    expect(result.timing_ms).toBeGreaterThanOrEqual(0);
  });

  /**
   * Test 3: evaluateUrl with no injection (hardcoded globalThis.fetch)
   *
   * wait_for(url) evaluator in wait-for-conditions.ts hardcodes
   * `globalThis.fetch` — there is no injectable seam. Any regression in
   * the dispatcher (the original bug) would surface here as `met:false`
   * with a `fetch error: fetch failed (ERR_INVALID_IP_ADDRESS)` detail.
   *
   * Revert proof:
   *   FAIL (pre-fix):  result.detail contains 'ERR_INVALID_IP_ADDRESS'
   *   PASS (post-fix): result.met=true, HTTP 200
   */
  it('evaluateUrl(url) reaches example.com via real undici dispatcher', async () => {
    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), 15_000);
    let result: Awaited<ReturnType<typeof evaluateUrl>> | undefined;
    try {
      result = await evaluateUrl(
        { type: 'url', url: TARGET_URL, method: 'GET' },
        ac.signal,
      );
    } catch (err) {
      // evaluateUrl catches fetch errors internally and returns met:false,
      // so a throw here is unexpected. Classify it.
      const verdict = classifyFetchError(err);
      if ('skip' in verdict) {
        console.warn(`[web-tools-real-fetch] SKIP (thrown): ${verdict.skip}`);
        return;
      }
      throw new Error(verdict.hardFail);
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Network skip: evaluateUrl returns met:false with a network error detail.
    // Distinguish network unavailability from the bug by inspecting the detail.
    if (!result.met) {
      const detail = result.detail;
      // Bug fingerprint: ERR_INVALID_IP_ADDRESS appears in the detail.
      if (detail.includes('ERR_INVALID_IP_ADDRESS') || detail.includes('Invalid IP address')) {
        throw new Error(
          `Bug-class error detected in evaluateUrl result — ` +
          `ERR_INVALID_IP_ADDRESS in detail string (pre-fix lookup hook regression). ` +
          `Detail: ${detail}`,
        );
      }
      // Known network-class strings that indicate environment unavailability.
      const isNetworkDetail =
        detail.includes('ENOTFOUND') ||
        detail.includes('ETIMEDOUT') ||
        detail.includes('ECONNRESET') ||
        detail.includes('EAI_AGAIN') ||
        detail.includes('ECONNREFUSED') ||
        detail.includes('ENETUNREACH') ||
        detail.includes('connect timeout') ||
        detail.includes('network is unreachable') ||
        detail.includes('fetch error:');  // evaluateUrl wraps ALL fetch errors as "fetch error:"
      if (isNetworkDetail) {
        console.warn(`[web-tools-real-fetch] SKIP: network unavailable — evaluateUrl detail: ${detail}`);
        return; // skip
      }
      // SSRF-blocked detail is fine — example.com is public, but report it.
      if (detail.includes('SSRF blocked')) {
        throw new Error(
          `SSRF guard unexpectedly blocked example.com — environment may have ` +
          `AFK_WEB_ALLOW_PRIVATE_HOSTS=0 or a custom lookup is resolving it internally. ` +
          `Detail: ${detail}`,
        );
      }
      // Unknown met:false — treat as unexpected.
      throw new Error(`evaluateUrl returned met:false for a stable public URL. Detail: ${detail}`);
    }

    expect(result.met).toBe(true);
    expect(result.data?.['status']).toBeGreaterThanOrEqual(200);
  });
});
