/**
 * SSRF egress gate for interactive browser navigation (#2301).
 *
 * Extracted from `index.ts` / `launcher.ts` so both stay under the 350-line
 * ceiling. Reuses the shared `checkEgressTarget` / `assertEgressAllowed`
 * (src/http-client/egress-guard.ts) — no new guard logic lives here — so the
 * same `AFK_WEB_ALLOW_PRIVATE_HOSTS` escape hatch applies as on web_request,
 * web_scrape, and wait_for.
 */

import type { BrowserContext } from 'playwright';
import type { BlockedByPolicy } from '../types.js';
import {
  assertEgressAllowed,
  checkEgressTarget,
  EgressBlockedError,
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
 * Per-session route guard: aborts every navigation request (top-level or
 * frame, including ones triggered by click/press/redirect) whose target the
 * egress guard refuses, and remembers the refusal so the caller can report a
 * truthful `blocked_by_policy` instead of Playwright's generic abort error.
 *
 * Contract: subresource requests pass through untouched; the guard covers
 * navigations only. `consume()` returns the last refusal once, then clears it.
 */
export class RequestGuardTrap {
  private lastError: unknown = undefined;

  async install(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) {
        await route.continue();
        return;
      }
      try {
        await assertEgressAllowed(request.url());
      } catch (err) {
        this.lastError = err;
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
  }

  consume(): unknown {
    const err = this.lastError;
    this.lastError = undefined;
    return err;
  }
}
