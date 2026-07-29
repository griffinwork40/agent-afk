/**
 * SSRF egress guard for the `src/web/` fetch layer.
 *
 * `web_scrape` is an always-on builtin: the model can call it with any URL, and
 * — because it returns page content back into context — a scraped page can
 * prompt-inject a follow-up fetch. Without a host filter that is a live SSRF
 * primitive reaching cloud instance metadata (`169.254.169.254` → IAM
 * credentials), `localhost` admin surfaces, and every RFC1918 internal service.
 * This module is the single classifier all egress paths consult (issue #575).
 *
 * Two entry points, both async because both resolve DNS:
 *
 *   - {@link assertEgressAllowed} — throws {@link EgressBlockedError} on a
 *     blocked target. Used inside the scraper, where a throw is already the
 *     failure channel.
 *   - {@link checkEgressTarget} — returns a structured verdict. Used by the
 *     handler's input validation, which surfaces a `ToolResult` refusal.
 *
 * Why resolve DNS rather than pattern-match the hostname: a hostname is an
 * attacker-controlled indirection. `internal.attacker.example` with an A record
 * of `127.0.0.1` passes any lexical check. We resolve and classify every
 * returned address, so the decision is made on where the connection would
 * actually land.
 *
 * Escape hatch: `AFK_WEB_ALLOW_PRIVATE_HOSTS=1` disables the guard wholesale,
 * for operators who legitimately scrape a local dev server. Off by default.
 *
 * @module web/egress-guard
 */

import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { env } from '../config/env.js';
import { retryFetch, type RetryFetchOptions } from './retryFetch.js';
import type { FetchFn } from './types.js';

/**
 * Blocked IPv4 CIDRs. `0.0.0.0/8` (RFC1122 "this network") is included because
 * `0.0.0.0` and short forms like `http://0/` route to localhost on Linux.
 * `100.64.0.0/10` (RFC6598 carrier-grade NAT) is where cloud-provider internal
 * services commonly live, so it is treated as internal too.
 */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // RFC1122 "this network" — 0.0.0.0 reaches localhost
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // RFC6598 carrier-grade NAT (cloud internal)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // RFC3927 link-local — includes 169.254.169.254 metadata
  ['172.16.0.0', 12], // RFC1918 private
  ['192.168.0.0', 16], // RFC1918 private
];

/**
 * Blocked IPv6 CIDRs.
 *
 * Invariant: `::/96` covers the unspecified address, `::1` loopback, AND the
 * deprecated IPv4-COMPATIBLE form (`::7f00:1`), which is a distinct encoding
 * from the IPv4-MAPPED form (`::ffff:7f00:1`). The mapped form is NOT matched by
 * an IPv6 rule — Node's `BlockList` unmaps `::ffff:a.b.c.d` and tests it against
 * the registered IPv4 rules instead (verified on Node 20/24). So the mapped
 * forms of every range above are covered by {@link BLOCKED_V4} automatically,
 * while the compatible form needs this explicit `::/96` entry. `64:ff9b::/96`
 * (RFC6052 NAT64) is listed because a NAT64 gateway translates the embedded
 * IPv4 address, which `BlockList` does not unmap for us.
 */
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ['::', 96], // unspecified, ::1 loopback, IPv4-compatible ::a.b.c.d
  ['64:ff9b::', 96], // RFC6052 NAT64 — embedded IPv4 is not unmapped by BlockList
  ['fc00::', 7], // RFC4193 unique-local (fc00::/8 + fd00::/8)
  ['fe80::', 10], // RFC4291 link-local
];

/**
 * Module-level singleton: the CIDR set is constant, so build the BlockList once.
 * `BlockList.check()` is a pure lookup, so sharing one instance is safe.
 */
const blockList = ((): BlockList => {
  const list = new BlockList();
  for (const [addr, prefix] of BLOCKED_V4) list.addSubnet(addr, prefix, 'ipv4');
  for (const [addr, prefix] of BLOCKED_V6) list.addSubnet(addr, prefix, 'ipv6');
  return list;
})();

/** Verdict from {@link checkEgressTarget}. */
export type EgressVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Thrown by {@link assertEgressAllowed} when a target is refused. */
export class EgressBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EgressBlockedError';
  }
}

/** Injectable seams so tests can classify without touching real DNS or env. */
export interface EgressGuardOptions {
  /** Override DNS resolution. Defaults to `dns/promises.lookup` (all records). */
  lookupFn?: (hostname: string) => Promise<readonly { address: string }[]>;
  /**
   * Override the opt-out read. Defaults to `env.AFK_WEB_ALLOW_PRIVATE_HOSTS`.
   * Never reads `process.env` directly — see `src/config/env.ts`.
   */
  allowPrivateHosts?: boolean;
}

/**
 * True when the operator has opted out of the guard.
 *
 * Truthy iff `'1'` or `'true'`, case-insensitive after trimming — the
 * convention used by other boolean-ish opt-in vars in this codebase.
 */
export function privateHostsAllowed(): boolean {
  const raw = env.AFK_WEB_ALLOW_PRIVATE_HOSTS?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** Strip the `[...]` brackets `new URL().hostname` wraps IPv6 literals in. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/** True when `ip` (a valid literal) falls inside a blocked range. */
function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return blockList.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

async function defaultLookup(hostname: string): Promise<readonly { address: string }[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Classify one URL as safe-to-fetch or blocked.
 *
 * Contract:
 *   - Rejects any non-http(s) scheme (`file:`, `gopher:`, …) — those are not
 *     egress targets the web layer should ever open.
 *   - An IP literal host is classified directly; no DNS is issued.
 *   - A hostname is resolved and EVERY returned address is classified. One
 *     internal address blocks the request (a rebinding attacker only needs one
 *     record to be honored). Resolution failure is NOT a block — the fetch will
 *     fail on its own with a truthful network error, and failing closed here
 *     would turn every offline/NXDOMAIN case into a confusing SSRF refusal.
 *   - Returns `{ allowed: true }` immediately when the operator set
 *     `AFK_WEB_ALLOW_PRIVATE_HOSTS`.
 */
export async function checkEgressTarget(
  rawUrl: string,
  opts: EgressGuardOptions = {},
): Promise<EgressVerdict> {
  if (opts.allowPrivateHosts ?? privateHostsAllowed()) return { allowed: true };

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `"${rawUrl}" is not a valid absolute URL` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `protocol "${parsed.protocol}" not supported (http/https only)`,
    };
  }

  const host = unbracket(parsed.hostname);
  const blockedReason = (addr: string, via: string): string =>
    `refusing to fetch ${via} — internal/private address ${addr} ` +
    `(loopback, link-local, cloud metadata, or RFC1918 space). ` +
    `Set AFK_WEB_ALLOW_PRIVATE_HOSTS=1 to allow private-host access.`;

  // IP literal: classify directly, no resolution needed.
  if (isIP(host) !== 0) {
    return isBlockedAddress(host)
      ? { allowed: false, reason: blockedReason(host, host) }
      : { allowed: true };
  }

  const lookupFn = opts.lookupFn ?? defaultLookup;
  let records: readonly { address: string }[];
  try {
    records = await lookupFn(host);
  } catch {
    // Unresolvable — let fetch surface the real network error.
    return { allowed: true };
  }

  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      return { allowed: false, reason: blockedReason(record.address, `${host} (resolved)`) };
    }
  }
  return { allowed: true };
}

/**
 * Throwing wrapper over {@link checkEgressTarget} for call sites whose failure
 * channel is already an exception (the scraper, the per-hop redirect loop).
 *
 * @throws {EgressBlockedError} when the target is refused.
 */
export async function assertEgressAllowed(
  rawUrl: string,
  opts: EgressGuardOptions = {},
): Promise<void> {
  const verdict = await checkEgressTarget(rawUrl, opts);
  if (!verdict.allowed) throw new EgressBlockedError(verdict.reason);
}

/** Max redirect hops followed by {@link guardedFetch}, matching the fetch spec. */
const MAX_REDIRECTS = 20;

/** Statuses that carry a `Location` the client is expected to follow. */
const REDIRECT_STATUS = new Set<number>([301, 302, 303, 307, 308]);

export interface GuardedFetchOptions extends EgressGuardOptions {
  /** Forwarded to {@link retryFetch} (retry counts, injectable sleep). */
  retry?: RetryFetchOptions;
}

/**
 * Invariant: the egress guard must be re-applied on EVERY redirect hop, so this
 * wrapper forces `redirect: 'manual'` and walks the chain itself.
 *
 * Native redirect-following happens inside undici with no interception point —
 * `redirect: 'follow'` means a public URL can 302 straight to
 * `169.254.169.254` and the app only ever sees the final body. Validating the
 * initial URL is therefore not enough; the check has to sit between hops, which
 * requires owning the loop.
 *
 * Contract:
 *   - Validates `url` before the first request, then validates each `Location`
 *     target before following it. A blocked hop throws
 *     {@link EgressBlockedError} and no request to that hop is issued.
 *   - Relative and protocol-relative `Location` values are resolved against the
 *     responding URL before validation.
 *   - Returns the first non-redirect response, exactly as `retryFetch` would.
 *     A redirect response whose `Location` is missing is returned as-is rather
 *     than treated as an error — the caller decides.
 *   - Redirect bodies are cancelled before the next hop so the socket is freed.
 *   - Throws after {@link MAX_REDIRECTS} hops to bound a redirect loop.
 */
export async function guardedFetch(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  opts: GuardedFetchOptions = {},
): Promise<Response> {
  const guardOpts: EgressGuardOptions = {
    ...(opts.lookupFn !== undefined ? { lookupFn: opts.lookupFn } : {}),
    ...(opts.allowPrivateHosts !== undefined ? { allowPrivateHosts: opts.allowPrivateHosts } : {}),
  };

  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertEgressAllowed(target, guardOpts);
    const res = await retryFetch(fetchFn, target, { ...init, redirect: 'manual' }, opts.retry ?? {});
    if (!REDIRECT_STATUS.has(res.status)) return res;

    const location = res.headers.get('location');
    if (location === null || location.trim() === '') return res;

    let next: string;
    try {
      next = new URL(location, res.url || target).toString();
    } catch {
      // An unparseable Location can't be followed — hand the redirect back.
      return res;
    }
    // Free the socket before issuing the next hop.
    await res.body?.cancel().catch(() => undefined);
    target = next;
  }
  throw new EgressBlockedError(
    `too many redirects (>${MAX_REDIRECTS}) starting from ${url}`,
  );
}
