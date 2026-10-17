/** Pre-navigation SSRF checks and caller-supplied render policy. */

import type { BrowserContext } from 'playwright';
import type { BlockedByPolicy } from '../types.js';
import { checkEgressTarget } from '../../http-client/egress-guard.js';

/** Refuse private targets before any browser interaction. */
export async function checkNavigationEgress(url: string): Promise<BlockedByPolicy | null> {
  const verdict = await checkEgressTarget(url);
  if (verdict.allowed) return null;
  return { outcome: 'blocked_by_policy', url, reason: verdict.reason };
}

/**
 * Preserve the caller's render policy: requestGuard is an arbitrary callback,
 * not necessarily the SSRF policy enforced by the proxy. Interactive contexts
 * do not install a route handler, preserving Chromium's HTTP cache (#3721).
 */
export async function installRenderRouteGuard(
  context: BrowserContext,
  guard: (url: string) => Promise<void>,
  onRefusal: (err: unknown) => void,
): Promise<void> {
  await context.route('**/*', async (route) => {
    try {
      await guard(route.request().url());
      await route.continue();
    } catch (err) {
      onRefusal(err);
      await route.abort('blockedbyclient');
    }
  });
}

export { invalidateOnRefusal, mainRefusalOutcome, renderRefusalError, runActionWithRetry, watchEgressRefusals } from './egress-attribution.js';
