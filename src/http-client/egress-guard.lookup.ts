/**
 * Factory for the undici Agent `connect.lookup` hook used by {@link guardedDispatcher}.
 *
 * Extracted from `egress-guard.ts` to keep that file below the 350-line
 * ceiling and to isolate the hook-contract complexity. This module is
 * `@internal` — it is not re-exported from any barrel/index and is only
 * imported by `egress-guard.ts`.
 *
 * @module http-client/egress-guard.lookup
 * @internal
 */

import { isIP } from 'node:net';

// Alias to signal intent: isIP returns 0 for non-IP strings.
const NOT_IP = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a single resolved address record as returned by the factory.
 * Matches the undici connect-hook's "all=true" callback argument shape.
 */
export interface LookupRecord {
  address: string;
  family: number;
}

/**
 * The callback signature undici passes to a connect-time `lookup` hook.
 *
 * undici (≥ 6.x on Node 18+) calls the hook with `options.all = true` and
 * `options.hints = 1024` (AI_ADDRCONFIG | AI_V4MAPPED on most platforms)
 * when the kernel supports `autoSelectFamily`. When `options.all` is truthy
 * the callback MUST be invoked with an array of `{address, family}` objects;
 * passing a single (address, family) pair causes `net` to throw
 * `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.
 */
export type LookupCallback =
  | ((err: null,    addresses: LookupRecord[])        => void)  // all=true form
  | ((err: null,    address:   string, family: number) => void)  // all=false form
  | ((err: Error,   address:   string, family: number) => void); // error form

/** Subset of the `options` object undici passes to the lookup hook. */
export interface LookupOptions {
  /** When true undici expects an array callback; single-address causes a runtime error. */
  all?: boolean;
  /**
   * Address-family preference. Node's `dns.LookupOptions.family` is typed as
   * `number | "IPv4" | "IPv6" | undefined` (union from Node types). In practice
   * undici / net only ever passes 0, 4, or 6. We accept the full union to match
   * the undici `LookupFunction` assignment site; at runtime the `=== 4 || === 6`
   * check naturally treats string values as "unspecified" (no filtering).
   */
  family?: number | 'IPv4' | 'IPv6';
}

/**
 * Dependency surface injected by the caller — both real implementations live
 * in `egress-guard.ts` so this file has no upward import cycle.
 *
 * @internal
 */
export interface GuardedLookupDeps {
  /**
   * Resolve a hostname to ALL its addresses.
   * Must return a list of `{address: string}` records (extra fields are fine).
   * On resolution failure it must reject.
   */
  lookupFn: (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;
  /** Return true when the given IP string falls inside a blocked CIDR range. */
  isBlocked: (ip: string) => boolean;
  /** Construct a block error with the appropriate message. */
  makeBlockError: (hostname: string, blockedAddress: string) => Error;
  /**
   * Construct an error for the case where a DNS record contains a non-IP
   * address string. Kept on the deps interface (rather than using `new Error`
   * inline) so callers can return a consistent error type (e.g.
   * `EgressBlockedError`) without this module importing from `egress-guard.ts`
   * and introducing an import cycle.
   */
  makeNonIpError: (hostname: string, record: string) => Error;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an undici `connect.lookup` hook that:
 *
 * Contract:
 *   1. Resolves the full record set via `deps.lookupFn`.
 *   2. Classifies EVERY address — any blocked address → callback with a
 *      `makeBlockError` result (fail closed; no filtered subset is returned).
 *   3. Applies `options.family` (4 or 6) filter to the surviving records ONLY
 *      after the full-set classification passes.
 *   4. If the family filter leaves zero records → callback with an error; an
 *      empty array is never passed to undici.
 *   5. If `options.all` is true → callback(null, [{address, family}, ...]).
 *   6. If `options.all` is falsy → callback(null, address, family).
 *   7. DNS errors pass through unchanged.
 *
 * Invariant: blocking is checked on the FULL record set before any filtering.
 * A record set of [public-v4, ::1] with family:4 MUST still be blocked because
 * ::1 is in the set — filtering first would silently allow the request.
 *
 * @internal
 */
export function createGuardedLookup(
  deps: GuardedLookupDeps,
): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return function guardedLookup(
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void {
    // Track whether callback has been successfully invoked (without throwing)
    // to prevent double-callback if the .catch belt-and-suspenders fires after
    // a successful delivery.
    let delivered = false;
    /**
     * Call `cb` at most once successfully. If `cb` throws on the first attempt,
     * `delivered` is NOT set — the caller's catch block can then attempt an
     * error-recovery call. If `cb` throws on the recovery attempt as well, the
     * throw propagates naturally (the promise chain's outer .catch will absorb it
     * since `delivered` is still false, preventing an infinite loop via a
     * secondary guard inside .catch).
     */
    const callOnce = (cb: LookupCallback, ...args: Parameters<LookupCallback>): void => {
      if (delivered) return;
      (cb as (...a: unknown[]) => void)(...args);
      // Only mark delivered if the call returned without throwing.
      delivered = true;
    };

    void deps.lookupFn(hostname).then(
      (records) => {
        // Step 1: classify the FULL set — fail closed on any blocked address
        // or any record whose address is not a valid IP (isIP() === 0).
        // Treating non-IP records as errors keeps the guard self-contained:
        // today `net` would reject such addresses itself, but the guard should
        // not depend on that downstream behaviour to remain fail-closed.
        for (const record of records) {
          if (isIP(record.address) === NOT_IP) {
            callOnce(
              callback,
              deps.makeNonIpError(hostname, record.address),
              '',
              0,
            );
            return;
          }
          if (deps.isBlocked(record.address)) {
            callOnce(
              callback,
              deps.makeBlockError(hostname, record.address),
              '',
              0,
            );
            return;
          }
        }

        // Step 2: apply optional family filter AFTER classification.
        const wantFamily = options.family ?? 0;
        const filtered =
          wantFamily === 4 || wantFamily === 6
            ? records.filter((r) => isIP(r.address) === wantFamily)
            : records;

        if (filtered.length === 0) {
          // Resolution failure, not a policy block: DNS returned valid IPs but
          // none matched the caller's address-family preference. This is
          // analogous to receiving an empty record set from the resolver — the
          // guard did not intervene; the network simply has no usable record.
          // Plain Error is correct here; EgressBlockedError is reserved for
          // guard-originated blocks (non-IP records, CIDR-blocked addresses).
          callOnce(
            callback,
            new Error(
              `DNS lookup for ${hostname} returned no addresses matching family ${wantFamily}`,
            ),
            '',
            0,
          );
          return;
        }

        try {
          if (options.all) {
            // all=true: undici requires the array form — single-address form causes
            // ERR_INVALID_IP_ADDRESS when autoSelectFamily is active (Node 24+).
            callOnce(
              callback,
              null,
              filtered.map((r) => ({ address: r.address, family: isIP(r.address) })),
            );
          } else {
            const first = filtered[0]!;
            callOnce(callback, null, first.address, isIP(first.address));
          }
        } catch (cbErr: unknown) {
          // If `callback` throws synchronously (the original #2754 failure class —
          // net's emitLookup threw ERR_INVALID_IP_ADDRESS), report the error back
          // through the callback so it reaches undici's error channel rather than
          // becoming an unhandled rejection on the void promise chain.
          callOnce(
            callback,
            cbErr instanceof Error ? cbErr : new Error(String(cbErr)),
            '',
            0,
          );
        }
      },
      (err: unknown) => {
        // DNS resolution failure — pass through unchanged.
        callOnce(
          callback,
          err instanceof Error ? err : new Error(String(err)),
          '',
          0,
        );
      },
    ).catch((err: unknown) => {
      // Belt-and-suspenders: if anything unexpected escapes the then/catch chain
      // (e.g. a callback throw propagated through the try/catch in onOk), surface
      // it through the callback so it reaches undici's error channel.
      // `delivered` guards against re-entry if the recovery call itself throws again.
      if (!delivered) {
        try {
          callOnce(
            callback,
            err instanceof Error ? err : new Error(String(err)),
            '',
            0,
          );
        } catch {
          // If the recovery call also throws, swallow it — we have no further
          // channel to report through, and re-throwing would produce an unhandled
          // rejection (the original problem). The error has already been surfaced
          // as far as possible.
        }
      }
    });
  };
}
