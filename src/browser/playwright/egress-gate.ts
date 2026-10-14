/**
 * SSRF egress gate for interactive browser navigation (#2301).
 *
 * Extracted from `index.ts` / `launcher.ts` so both stay under the 350-line
 * ceiling. Reuses the shared `checkEgressTarget` / `assertEgressAllowed`
 * (src/http-client/egress-guard.ts) — no new guard logic lives here — so the
 * same `AFK_WEB_ALLOW_PRIVATE_HOSTS` escape hatch applies as on web_request,
 * web_scrape, and wait_for.
 */

import type { BrowserContext, Page, Response } from 'playwright';
import type { BlockedByPolicy } from '../types.js';
import {
  assertEgressAllowed,
  checkEgressTarget,
  EgressBlockedError,
  isBlockedAddress,
  privateHostsAllowed,
} from '../../http-client/egress-guard.js';

/**
 * Pre-navigation check: refuse private/loopback/link-local/cloud-metadata
 * targets before any browser interaction.
 *
 * @returns a `blocked_by_policy` outcome when refused, `null` when allowed.
 */
export async function checkNavigationEgress(url: string): Promise<BlockedByPolicy | null> {
  const verdict = await checkEgressTarget(url);
  if (verdict.allowed) return null;
  return { outcome: 'blocked_by_policy', url, reason: verdict.reason };
}

/**
 * Map an error raised by a navigation the request guard aborted into a
 * `blocked_by_policy` outcome; any other error yields `null`.
 */
export function egressBlockOutcome(err: unknown, url: string): BlockedByPolicy | null {
  if (!(err instanceof EgressBlockedError)) return null;
  return { outcome: 'blocked_by_policy', url, reason: err.message };
}

/**
 * Record main-frame navigation responses while an action runs, so act() can
 * feed the LAST one to {@link checkRedirectChain}. Click/press-triggered
 * navigations have no goto() return value, and Playwright never routes their
 * redirect hops, so this is the only way act() sees the hop chain and the IP
 * Chromium actually connected to (#2313 round 1, items 1 and 3).
 *
 * Contract: call the returned stop function exactly once, after the action
 * settles (success or failure); it detaches the listener and returns the last
 * recorded response, or `null` when the action did not navigate the main frame.
 */
export function watchMainFrameNavigation(page: Page): () => Response | null {
  let last: Response | null = null;
  const onResponse = (r: Response): void => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) last = r;
  };
  page.on('response', onResponse);
  return () => {
    page.off('response', onResponse);
    return last;
  };
}

/**
 * Walk the redirect chain of a Playwright Response and check each hop URL and
 * each hop's serverAddr IP against the egress guard. Returns a
 * `blocked_by_policy` outcome if any hop touched a private address, or `null`
 * when the chain is clean.
 *
 * Contract: call this AFTER navigation succeeds (page.goto resolves) and BEFORE
 * building any observation or screenshot. Returns null immediately when
 * privateHostsAllowed() is true so the hot path stays cheap.
 *
 * Null serverAddr: occurs for cache hits, service-worker-served responses,
 * about:blank, and responses with no network round-trip. We treat null as
 * "no IP to classify" — not a block. The URL check on that hop still runs.
 */
export async function checkRedirectChain(
  response: Response | null,
  finalUrl: string,
): Promise<BlockedByPolicy | null> {
  if (privateHostsAllowed()) return null;
  if (response === null) return null;

  // Collect all hops: walk redirectedFrom() chain (oldest first), append final.
  const hops: Response[] = [];
  let cur: Response | null = response;
  while (cur !== null) {
    hops.unshift(cur);
    const fromReq = cur.request().redirectedFrom();
    cur = fromReq !== null ? (await fromReq.response()) : null;
  }

  for (const hop of hops) {
    const hopUrl = hop.url();
    // Check hop URL via egress guard (DNS-based).
    const verdict = await checkEgressTarget(hopUrl);
    if (!verdict.allowed) {
      return { outcome: 'blocked_by_policy', url: finalUrl, reason: verdict.reason };
    }
    // Check the IP Chromium actually connected to (DNS rebinding, item 3).
    const serverAddr = await hop.serverAddr();
    const addr = serverAddr?.ipAddress;
    if (addr !== undefined && addr !== '' && isBlockedAddress(addr)) {
      const reason =
        `refusing navigation — Chromium connected to private/internal address ` +
        `${addr} for ${hopUrl}. ` +
        `Set AFK_WEB_ALLOW_PRIVATE_HOSTS=1 to allow private-host access.`;
      return { outcome: 'blocked_by_policy', url: finalUrl, reason };
    }
  }
  return null;
}

/**
 * Per-session route guard: aborts every http(s) request whose target the
 * egress guard refuses, and remembers the refusal so the caller can report a
 * truthful `blocked_by_policy` instead of Playwright's generic abort error.
 *
 * Contract: install() is a no-op when privateHostsAllowed() is true (skipping
 * the catch-all route preserves the HTTP cache). consume() returns the last
 * refusal once, then clears it. clear() discards any latched error without
 * returning it — call at the start of each open()/act() to prevent a stale
 * refusal from a prior iframe from poisoning an unrelated later failure.
 */
export class RequestGuardTrap {
  private lastError: unknown = undefined;

  async install(context: BrowserContext): Promise<void> {
    // Item 7: skip route install when private hosts are allowed. Installing a
    // catch-all route disables Chromium's HTTP cache, which is a needless
    // penalty when the guard is opted out of anyway.
    if (privateHostsAllowed()) return;

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      // Guard every http(s) request (navigation or subresource). Non-http(s)
      // schemes (data:, blob:, chrome-extension:, etc.) are passed through
      // unchanged so nothing new breaks.
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        await route.continue();
        return;
      }
      try {
        await assertEgressAllowed(url);
      } catch (err) {
        this.lastError = err;
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
  }

  /** Discard any latched refusal. Call at the start of open()/act(). */
  clear(): void {
    this.lastError = undefined;
  }

  /** Return and clear the last refusal. */
  consume(): unknown {
    const err = this.lastError;
    this.lastError = undefined;
    return err;
  }
}
