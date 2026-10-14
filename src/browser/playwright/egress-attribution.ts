/**
 * Attribute guarded-egress-proxy refusals to the page operation they affected
 * (#2301, ADR 20261014 open question 1).
 *
 * Contract: a refusal counts for a page only when BOTH (a) the proxy recorded
 * it after this watcher's mark and (b) this page issued a request (or opened a
 * websocket) to the same normalised `host:port` during the window. The proxy
 * is shared by every context, so (b) keeps concurrent sessions and renders
 * from blaming each other, and the proxy record — never a Chromium net::ERR
 * string — is what proves the refusal was a policy block. `main` is set only
 * when the matching request was a main-frame navigation (incl. redirect hops,
 * which Playwright emits as fresh navigation requests).
 */

import type { Page, Request, WebSocket } from 'playwright';
import type { BlockedByPolicy } from '../types.js';
import { EgressBlockedError } from '../../http-client/egress-guard.js';
import { targetKeyFromUrl, type EgressRefusal } from './egress-proxy.js';
import type { RefusalLog } from './egress-launch.js';

export interface RefusalVerdict {
  main: EgressRefusal | undefined;
  any: EgressRefusal | undefined;
}

export interface EgressWatch {
  /** Refusals attributable to this page so far. Callable repeatedly. */
  check(): RefusalVerdict;
  /** Detach listeners; returns a final {@link check}. Call exactly once. */
  stop(): RefusalVerdict;
}

const NONE: RefusalVerdict = { main: undefined, any: undefined };

export function watchEgressRefusals(page: Page, log: RefusalLog | undefined): EgressWatch {
  if (log === undefined) return { check: () => NONE, stop: () => NONE };
  const mark = log.mark();
  const mainKeys = new Set<string>();
  const allKeys = new Set<string>();
  const add = (url: string, main: boolean): void => {
    const key = targetKeyFromUrl(url);
    if (key === null) return;
    allKeys.add(key);
    if (main) mainKeys.add(key);
  };
  const onRequest = (r: Request): void => {
    add(r.url(), r.isNavigationRequest() && r.frame() === page.mainFrame());
  };
  const onSocket = (ws: WebSocket): void => add(ws.url(), false);
  page.on('request', onRequest);
  page.on('websocket', onSocket);
  const check = (): RefusalVerdict => {
    const hits = log.refusalsSince(mark);
    return {
      main: hits.find((r) => mainKeys.has(r.target)),
      any: hits.find((r) => allKeys.has(r.target)),
    };
  };
  return {
    check,
    stop: () => {
      page.off('request', onRequest);
      page.off('websocket', onSocket);
      return check();
    },
  };
}

/** Map a main-frame refusal to the tool-facing `blocked_by_policy` outcome. */
export function mainRefusalOutcome(v: RefusalVerdict, url: string): BlockedByPolicy | null {
  return v.main !== undefined ? { outcome: 'blocked_by_policy', url, reason: v.main.reason } : null;
}

/** Any refusal for a render page → the EgressBlockedError web_scrape already treats as terminal. */
export function renderRefusalError(v: RefusalVerdict): EgressBlockedError | undefined {
  return v.any !== undefined ? new EgressBlockedError(v.any.reason) : undefined;
}

/**
 * Invalidate the session before returning a refusal so a later
 * browser_observe / browser_screenshot cannot read whatever the tab holds
 * (#2313 round 2, item 2) — mirrors the domain-recheck rollback.
 */
export async function invalidateOnRefusal(
  outcome: BlockedByPolicy,
  invalidate: () => Promise<void>,
): Promise<BlockedByPolicy> {
  await invalidate().catch(() => undefined);
  return outcome;
}
