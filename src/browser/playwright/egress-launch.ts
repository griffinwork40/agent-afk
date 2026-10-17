/**
 * Launch/lifecycle glue between {@link BrowserLauncher} and the guarded egress
 * proxy (#2301, ADR 20261014 PATH_B). Kept out of `launcher.ts` so that file
 * stays under the 350-code-line ceiling.
 *
 * Contract: `start()` returns the `chromium.launch` options. When the guard is
 * active it first awaits the proxy listening on 127.0.0.1 and routes ALL
 * Chromium egress through it (session contexts and ephemeral `renderHtml`
 * contexts inherit browser-level proxy settings). When the operator opted out
 * via AFK_WEB_ALLOW_PRIVATE_HOSTS — read ONCE per browser lifetime, at launch —
 * no proxy is installed. `stop()` is
 * idempotent and must be called on launch failure, crash recovery and shutdown.
 */

import type { LaunchOptions } from 'playwright';
import { privateHostsAllowed } from '../../http-client/egress-guard.js';
import { registerCleanup } from '../../utils/cleanupRegistry.js';
import { EgressProxy, type EgressProxyDeps, type EgressRefusal } from './egress-proxy.js';

/**
 * Chromium flags that close egress paths an HTTP proxy cannot see: QUIC
 * (UDP HTTP/3) and non-proxied WebRTC UDP.
 */
export const EGRESS_LAUNCH_ARGS: readonly string[] = [
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** Chromium rule that removes the implicit loopback bypass (see buildLaunchOptions). */
export const EGRESS_PROXY_BYPASS = '<-loopback>';

/** Pure builder for the `chromium.launch` options (unit-tested). */
export function buildLaunchOptions(headless: boolean, proxyPort: number | undefined): LaunchOptions {
  if (proxyPort === undefined) return { headless };
  // `<-loopback>` is passed EXPLICITLY so loopback / link-local (IMDS) targets
  // are proxied even when PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK
  // disables Playwright's implicit append; shouldProxyLoopback sees the rule
  // and does not duplicate it. No other bypass is ever added.
  return {
    headless,
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: EGRESS_PROXY_BYPASS },
    args: [...EGRESS_LAUNCH_ARGS],
  };
}

/** Read side of the refusal log used by the provider for attribution. */
export interface RefusalLog {
  mark(): number;
  refusalsSince(mark: number): EgressRefusal[];
}

export class GuardedEgress implements RefusalLog {
  private proxy: EgressProxy | undefined;
  private unregister: (() => void) | undefined;

  constructor(private readonly deps: EgressProxyDeps = {}) {}

  /** Start the proxy (when guarded) and return launch options. */
  async start(headless: boolean): Promise<LaunchOptions> {
    await this.stop();
    if (privateHostsAllowed()) return buildLaunchOptions(headless, undefined);
    const proxy = new EgressProxy(this.deps);
    const port = await proxy.listen();
    this.proxy = proxy;
    this.unregister = registerCleanup(() => this.stop());
    return buildLaunchOptions(headless, port);
  }

  /** True while a proxy is installed (guard active for the current browser). */
  isActive(): boolean {
    return this.proxy !== undefined;
  }

  mark(): number {
    return this.proxy?.mark() ?? 0;
  }

  refusalsSince(mark: number): EgressRefusal[] {
    return this.proxy?.refusalsSince(mark) ?? [];
  }

  /** Close the proxy with its bounded drain. Idempotent; never throws. */
  async stop(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = undefined;
    this.unregister?.();
    this.unregister = undefined;
    if (proxy !== undefined) await proxy.close().catch(() => undefined);
  }
}
