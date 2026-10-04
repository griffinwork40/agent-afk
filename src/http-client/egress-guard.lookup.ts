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
    void deps.lookupFn(hostname).then(
      (records) => {
        // Step 1: classify the FULL set — fail closed on any blocked address.
        for (const record of records) {
          if (deps.isBlocked(record.address)) {
            (callback as (err: Error, address: string, family: number) => void)(
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
          (callback as (err: Error, address: string, family: number) => void)(
            new Error(
              `DNS lookup for ${hostname} returned no addresses matching family ${wantFamily}`,
            ),
            '',
            0,
          );
          return;
        }

        if (options.all) {
          // all=true: undici requires the array form — single-address form causes
          // ERR_INVALID_IP_ADDRESS when autoSelectFamily is active (Node 24+).
          (callback as (err: null, addresses: LookupRecord[]) => void)(
            null,
            filtered.map((r) => ({ address: r.address, family: isIP(r.address) })),
          );
        } else {
          const first = filtered[0]!;
          (callback as (err: null, address: string, family: number) => void)(
            null,
            first.address,
            isIP(first.address),
          );
        }
      },
      (err: unknown) => {
        // DNS resolution failure — pass through unchanged.
        (callback as (err: Error, address: string, family: number) => void)(
          err instanceof Error ? err : new Error(String(err)),
          '',
          0,
        );
      },
    );
  };
}
