/**
 * Shared post-navigation domain-policy re-check for the Playwright provider.
 *
 * Extracted from `act()` so `open()` and `act()` cannot drift apart: both
 * navigation paths now call the SAME function, so a fix or a hardening applied
 * here lands on every path that can move the tab.
 *
 * @module browser/playwright/domain-recheck
 */

import type { BlockedByPolicy, BrowserConfig } from '../types.js';
import { enforceDomainPolicy } from '../config.js';

// ---------------------------------------------------------------------------
// Minimal page surface
// ---------------------------------------------------------------------------

/**
 * The minimal slice of Playwright's `Page` this module needs.
 *
 * Contract: structurally satisfied by a real `playwright.Page`, so callers pass
 * their page straight through. Declaring the narrow shape (instead of importing
 * `Page`) keeps this module unit-testable with a two-method stub — no browser
 * process, no playwright import at test time.
 */
export interface RecheckablePage {
  url(): string;
  goBack(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Post-navigation re-check
// ---------------------------------------------------------------------------

// Invariant: every URL the session tab actually LANDS on has been passed
// through enforceDomainPolicy at least once. A pre-navigation check alone is
// insufficient — `page.goto()` and in-page navigations both follow 30x
// redirects transparently, so an allowed host can hand the tab to a blocked
// one after the pre-check has already passed. That was the open() hole in
// issue #576: the allowlist was enforced on the REQUESTED url and never on
// the LANDED url, so `allowed.example` → 302 → `blocked.example` returned a
// full observation (and screenshot) from the blocked host.
//
// Two rules keep the invariant true with one policy call per navigation:
//   1. `clearedUrl` is a URL the caller has ALREADY cleared through the
//      policy. When the tab did not move off it, re-checking is redundant.
//   2. Any other landed URL is unvetted and must be checked before its
//      content is read.
//
// Callers MUST invoke this before building an observation or capturing a
// screenshot. Returning `BlockedByPolicy` is only half the guard; the other
// half is that the blocked page's content is never read at all.
/**
 * Re-validate the URL the tab landed on after a navigation.
 *
 * @param page       The session tab. Only `url()` and `goBack()` are used.
 * @param config     Browser config carrying the allow/block lists.
 * @param clearedUrl A URL already cleared by this policy — the pre-navigation
 *                   target for `open()`, the pre-action URL for `act()`.
 * @param invalidateSession Closes the session if rollback fails, preventing a
 *                          later read from observing the blocked page.
 * @returns `BlockedByPolicy` when the landed URL is refused (after a
 *          best-effort `goBack()`), or `null` when the tab may be observed.
 */
export async function recheckLandedUrl(
  page: RecheckablePage,
  config: BrowserConfig,
  clearedUrl: string,
  invalidateSession: () => Promise<void>,
): Promise<BlockedByPolicy | null> {
  const landedUrl = page.url();

  // Tab never moved off the already-cleared URL — nothing new to vet.
  if (landedUrl === clearedUrl) {
    return null;
  }

  const policy = enforceDomainPolicy(landedUrl, config);
  if (policy.allowed) {
    return null;
  }

  // If rollback fails, invalidate the session before returning the refusal.
  // Otherwise a later observe() or screenshot() could read the blocked page
  // without passing through this post-navigation policy check.
  try {
    await page.goBack();
  } catch {
    await invalidateSession();
  }

  return {
    outcome: 'blocked_by_policy',
    url: landedUrl,
    reason: policy.reason,
  };
}
