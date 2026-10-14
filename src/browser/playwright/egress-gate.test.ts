import { describe, it, expect, vi } from 'vitest';

vi.mock('../../http-client/egress-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../http-client/egress-guard.js')>();
  return { ...actual, privateHostsAllowed: vi.fn(() => false) };
});

import {
  checkNavigationEgress,
  checkRedirectChain,
  egressBlockOutcome,
  RequestGuardTrap,
} from './egress-gate.js';
import { EgressBlockedError, privateHostsAllowed } from '../../http-client/egress-guard.js';

// ---------------------------------------------------------------------------
// Minimal Response stub
// ---------------------------------------------------------------------------

function makeStubResponse(opts: {
  url: string;
  ip?: string;
  redirectedFrom?: ReturnType<typeof makeStubResponse>;
}): {
  url: () => string;
  serverAddr: () => { ipAddress: string } | null;
  request: () => { redirectedFrom: () => { response: () => ReturnType<typeof makeStubResponse> } | null };
} {
  return {
    url: () => opts.url,
    serverAddr: () => (opts.ip !== undefined ? { ipAddress: opts.ip } : null),
    request: () => ({
      redirectedFrom: () =>
        opts.redirectedFrom !== undefined
          ? { response: () => opts.redirectedFrom! }
          : null,
    }),
  };
}

describe('egress-gate (#2301)', () => {
  it('checkNavigationEgress blocks the IMDS literal before navigation', async () => {
    const out = await checkNavigationEgress('http://169.254.169.254/latest/meta-data/');
    expect(out?.outcome).toBe('blocked_by_policy');
    expect(out?.url).toBe('http://169.254.169.254/latest/meta-data/');
  });

  it('checkNavigationEgress allows a public IP literal', async () => {
    expect(await checkNavigationEgress('https://93.184.216.34/')).toBeNull();
  });

  it('egressBlockOutcome maps only EgressBlockedError', () => {
    const blocked = egressBlockOutcome(new EgressBlockedError('nope'), 'http://127.0.0.1/');
    expect(blocked).toEqual({ outcome: 'blocked_by_policy', url: 'http://127.0.0.1/', reason: 'nope' });
    expect(egressBlockOutcome(new Error('net::ERR_FAILED'), 'http://x/')).toBeNull();
    expect(egressBlockOutcome(null, 'http://x/')).toBeNull();
  });

  it('RequestGuardTrap records a refusal once and clears it on consume', async () => {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = { route: vi.fn(async (_p: string, h: typeof handler) => { handler = h; }) };
    const trap = new RequestGuardTrap();
    await trap.install(context as never);
    const abort = vi.fn().mockResolvedValue(undefined);
    await handler!({
      request: () => ({ url: () => 'http://127.0.0.1:7777/', isNavigationRequest: () => true }),
      continue: vi.fn(),
      abort,
    });
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
    expect(trap.consume()).toBeInstanceOf(EgressBlockedError);
    expect(trap.consume()).toBeUndefined();
  });

  // Item 2: subresource requests on http(s) are now guarded.
  it('RequestGuardTrap blocks an http subresource pointing at IMDS', async () => {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = { route: vi.fn(async (_p: string, h: typeof handler) => { handler = h; }) };
    const trap = new RequestGuardTrap();
    await trap.install(context as never);
    const abort = vi.fn().mockResolvedValue(undefined);
    const cont = vi.fn().mockResolvedValue(undefined);
    // isNavigationRequest: false — subresource — but URL is IMDS → must block.
    await handler!({
      request: () => ({ url: () => 'http://169.254.169.254/latest/meta-data/', isNavigationRequest: () => false }),
      continue: cont,
      abort,
    });
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
    expect(cont).not.toHaveBeenCalled();
  });

  // Item 2: non-http(s) schemes still pass through.
  it('RequestGuardTrap passes non-http(s) requests through unchanged', async () => {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = { route: vi.fn(async (_p: string, h: typeof handler) => { handler = h; }) };
    const trap = new RequestGuardTrap();
    await trap.install(context as never);
    const cont = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    await handler!({
      request: () => ({ url: () => 'data:text/plain,hello', isNavigationRequest: () => false }),
      continue: cont,
      abort,
    });
    expect(cont).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });

  // Item 7: skip install when privateHostsAllowed is true.
  it('RequestGuardTrap.install skips route() when privateHostsAllowed is true', async () => {
    vi.mocked(privateHostsAllowed).mockReturnValue(true);
    const context = { route: vi.fn() };
    const trap = new RequestGuardTrap();
    await trap.install(context as never);
    expect(context.route).not.toHaveBeenCalled();
    vi.mocked(privateHostsAllowed).mockReturnValue(false);
  });

  // Item 4: clear() discards latched error without returning it.
  it('RequestGuardTrap.clear() discards latched error so next consume returns undefined', async () => {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = { route: vi.fn(async (_p: string, h: typeof handler) => { handler = h; }) };
    const trap = new RequestGuardTrap();
    await trap.install(context as never);
    await handler!({
      request: () => ({ url: () => 'http://127.0.0.1/', isNavigationRequest: () => true }),
      continue: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
    });
    trap.clear();
    expect(trap.consume()).toBeUndefined();
  });

  // Items 1+3: checkRedirectChain — blocked hop URL.
  it('checkRedirectChain blocks when a redirect hop URL is private', async () => {
    const resp = makeStubResponse({ url: 'http://169.254.169.254/', ip: undefined });
    const result = await checkRedirectChain(resp as never, 'https://final.example.com/');
    expect(result).toMatchObject({ outcome: 'blocked_by_policy' });
  });

  // Item 3: checkRedirectChain — blocked serverAddr IP (DNS rebinding).
  it('checkRedirectChain blocks when serverAddr IP is private (DNS rebinding)', async () => {
    // Public URL but Chromium connected to a private IP.
    const resp = makeStubResponse({ url: 'https://public.example.com/', ip: '192.168.1.1' });
    const result = await checkRedirectChain(resp as never, 'https://public.example.com/');
    expect(result).toMatchObject({ outcome: 'blocked_by_policy' });
    expect(result?.reason).toContain('192.168.1.1');
  });

  // Items 1+3: checkRedirectChain — clean chain passes.
  it('checkRedirectChain returns null for a clean public response', async () => {
    const resp = makeStubResponse({ url: 'https://93.184.216.34/', ip: '93.184.216.34' });
    const result = await checkRedirectChain(resp as never, 'https://93.184.216.34/');
    expect(result).toBeNull();
  });

  // Item 3: null serverAddr is not a block.
  it('checkRedirectChain treats null serverAddr as clean (cache/service worker)', async () => {
    const resp = makeStubResponse({ url: 'https://public.example.com/', ip: undefined });
    const result = await checkRedirectChain(resp as never, 'https://public.example.com/');
    expect(result).toBeNull();
  });

  // Items 1+3: null response (navigation error) is not a block.
  it('checkRedirectChain returns null when response is null', async () => {
    expect(await checkRedirectChain(null, 'https://example.com/')).toBeNull();
  });

  // Item 7: checkRedirectChain short-circuits when privateHostsAllowed.
  it('checkRedirectChain returns null immediately when privateHostsAllowed is true', async () => {
    vi.mocked(privateHostsAllowed).mockReturnValue(true);
    const resp = makeStubResponse({ url: 'http://127.0.0.1/', ip: '127.0.0.1' });
    const result = await checkRedirectChain(resp as never, 'http://127.0.0.1/');
    expect(result).toBeNull();
    vi.mocked(privateHostsAllowed).mockReturnValue(false);
  });
});

describe('checkRedirectChain — behind the guarded egress proxy', () => {
  it('skips the serverAddr check when proxied (serverAddr is the proxy loopback)', async () => {
    const resp = makeStubResponse({ url: 'https://93.184.216.34/', ip: '127.0.0.1' });
    expect(await checkRedirectChain(resp as never, 'https://93.184.216.34/', true)).toBeNull();
    expect(await checkRedirectChain(resp as never, 'https://93.184.216.34/')).toMatchObject({ outcome: 'blocked_by_policy' });
  });
});
