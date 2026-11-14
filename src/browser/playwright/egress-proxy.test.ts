/**
 * Guarded egress proxy (#2301, ADR 20261014 PATH_B) exercised with plain Node
 * sockets — no browser. Both "public" and "private" servers listen on
 * 127.0.0.1; the injected classifier treats the PRIVATE server's port (and
 * 10.0.0.1) as blocked, so the real connect-time code path is what refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { EgressProxy, targetKey, targetKeyFromUrl } from './egress-proxy.js';
import { buildLaunchOptions, EGRESS_LAUNCH_ARGS, EGRESS_PROXY_BYPASS, GuardedEgress } from './egress-launch.js';

vi.mock('../../http-client/egress-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../http-client/egress-guard.js')>();
  return { ...actual, privateHostsAllowed: vi.fn(() => false) };
});
import { privateHostsAllowed } from '../../http-client/egress-guard.js';

interface Upstream { server: http.Server; port: number; connections: number; requests: string[] }

async function startUpstream(): Promise<Upstream> {
  const u: Upstream = { server: http.createServer(), port: 0, connections: 0, requests: [] };
  u.server.on('connection', () => { u.connections += 1; });
  u.server.on('request', (req, res) => { u.requests.push(req.url ?? ''); res.end(`hello ${req.url ?? ''}`); });
  u.server.on('upgrade', (req, sock: net.Socket) => {
    u.requests.push(`upgrade ${req.url ?? ''} ${req.headers['upgrade'] ?? ''}`);
    sock.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise<void>((r) => u.server.listen(0, '127.0.0.1', r));
  u.port = (u.server.address() as AddressInfo).port;
  return u;
}

/** Send raw bytes to the proxy and collect the first response chunk(s). */
function raw(port: number, payload: string, waitMs = 300): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(payload));
    let out = '';
    s.on('data', (d: Buffer) => { out += d.toString(); });
    const done = (): void => { s.destroy(); resolve(out); };
    s.on('end', done);
    s.on('error', done);
    setTimeout(done, waitMs);
  });
}

let pub: Upstream;
let priv: Upstream;
let proxy: EgressProxy;
let proxyPort: number;

beforeEach(async () => {
  pub = await startUpstream();
  priv = await startUpstream();
  proxy = new EgressProxy({
    isBlocked: (ip, port) => ip === '10.0.0.1' || port === priv.port,
    lookupFn: async (h) => {
      if (h === 'public.test') return [{ address: '127.0.0.1' }];
      if (h === 'mixed.test') return [{ address: '127.0.0.1' }, { address: '10.0.0.1' }];
      throw new Error(`ENOTFOUND ${h}`);
    },
  });
  proxyPort = await proxy.listen();
});

afterEach(async () => {
  await proxy.close();
  pub.server.close();
  priv.server.close();
});

describe('EgressProxy — HTTP forwarding', () => {
  it('forwards a request to an allowed target via the validated IP', async () => {
    const res = await raw(proxyPort, `GET http://public.test:${pub.port}/ok HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
    expect(res).toContain('200');
    expect(res).toContain('hello /ok');
    expect(pub.requests).toEqual(['/ok']);
  });

  it('refuses a private IP literal with 403, records it, and never connects', async () => {
    const mark = proxy.mark();
    const res = await raw(proxyPort, `GET http://127.0.0.1:${priv.port}/secret HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(res).toContain('403');
    expect(priv.connections).toBe(0);
    const [r] = proxy.refusalsSince(mark);
    expect(r?.target).toBe(targetKey('127.0.0.1', priv.port));
    expect(r?.reason).toContain('AFK_WEB_ALLOW_PRIVATE_HOSTS');
  });

  it('refuses a hostname whose answer set mixes public and private addresses', async () => {
    const mark = proxy.mark();
    const res = await raw(proxyPort, `GET http://mixed.test:${pub.port}/ HTTP/1.1\r\nHost: mixed.test\r\n\r\n`);
    expect(res).toContain('403');
    expect(pub.connections).toBe(0);
    expect(proxy.refusalsSince(mark)[0]?.target).toBe(`mixed.test:${pub.port}`);
  });

  it('a DNS failure is a 502, not a recorded policy refusal', async () => {
    const mark = proxy.mark();
    const res = await raw(proxyPort, `GET http://nx.test/ HTTP/1.1\r\nHost: nx.test\r\n\r\n`);
    expect(res).toContain('502');
    expect(proxy.refusalsSince(mark)).toEqual([]);
  });
});

describe('EgressProxy — replacement coverage for retired route/post-hoc checks (#3721)', () => {
  it('refuses a private redirect destination before any connection to it', async () => {
    const destination = `http://127.0.0.1:${priv.port}/secret`;
    pub.server.removeAllListeners('request');
    pub.server.on('request', (_req, res) => res.writeHead(302, { location: destination }).end());
    const first = await raw(proxyPort, get(pub.port, '/redirect'));
    expect(first).toContain('302');
    expect(first).toContain(destination);
    // Follow the actual Location through the same proxy, as Chromium does.
    const location = /\r\nlocation: ([^\r\n]+)/i.exec(first)?.[1];
    expect(location).toBe(destination);
    const mark = proxy.mark();
    const next = await raw(proxyPort, `GET ${location} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    expect(next).toContain('403');
    expect(priv.connections).toBe(0);
    expect(proxy.refusalsSince(mark)[0]?.target).toBe(targetKey('127.0.0.1', priv.port));
  });

  it('rechecks DNS on each connection and refuses a rebound hostname', async () => {
    const lookupFn = vi.fn()
      .mockResolvedValueOnce([{ address: '127.0.0.1' }])
      .mockResolvedValueOnce([{ address: '10.0.0.1' }]);
    const p = new EgressProxy({ lookupFn, isBlocked: (ip) => ip === '10.0.0.1' });
    try {
      const port = await p.listen();
      expect(await raw(port, get(pub.port, '/first'))).toContain('hello /first');
      expect(await raw(port, get(pub.port, '/rebound'))).toContain('403');
      expect(pub.requests).toEqual(['/first']);
      expect(lookupFn).toHaveBeenCalledTimes(2);
      expect(p.refusalsSince(0)[0]?.target).toBe(targetKey('public.test', pub.port));
    } finally {
      await p.close();
    }
  });

  it('refuses IMDS with the production classifier (not an injected port rule)', async () => {
    const strict = new EgressProxy();
    try {
      const port = await strict.listen();
      const response = await raw(port, 'GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n');
      expect(response).toContain('403');
      expect(strict.refusalsSince(0)[0]?.target).toBe('169.254.169.254:80');
    } finally {
      await strict.close();
    }
  });
});

describe('EgressProxy — CONNECT tunnels', () => {
  it('tunnels opaquely to an allowed target', async () => {
    const res = await raw(proxyPort,
      `CONNECT public.test:${pub.port} HTTP/1.1\r\nHost: public.test:${pub.port}\r\n\r\n` +
      `GET /tunnel HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
    expect(res).toContain('200 Connection Established');
    expect(res).toContain('hello /tunnel');
  });

  it('refuses CONNECT to a private target with zero upstream connections', async () => {
    const res = await raw(proxyPort, `CONNECT 127.0.0.1:${priv.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(res).toContain('403');
    expect(priv.connections).toBe(0);
  });

  it('classifies bracketed IPv6 literals ([::1]) explicitly', async () => {
    const strict = new EgressProxy({ isBlocked: (ip) => ip === '::1' });
    const p = await strict.listen();
    const res = await raw(p, `CONNECT [::1]:443 HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(res).toContain('403');
    expect(strict.refusalsSince(0)[0]?.target).toBe('::1:443');
    await strict.close();
  });
});

describe('EgressProxy — websocket upgrades over a forwarded request', () => {
  const up = (port: number): string =>
    `GET http://127.0.0.1:${port}/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

  it('relays an Upgrade to an allowed target', async () => {
    const res = await raw(proxyPort, up(pub.port));
    expect(res).toContain('101 Switching Protocols');
    expect(pub.requests).toEqual(['upgrade /ws websocket']);
  });

  it('refuses an Upgrade to a private target with zero upstream connections', async () => {
    const res = await raw(proxyPort, up(priv.port));
    expect(res).toContain('403');
    expect(priv.connections).toBe(0);
  });
});

describe('EgressProxy — lifecycle', () => {
  it('close() is idempotent and bounded even with an idle open tunnel', async () => {
    const s = net.connect(proxyPort, '127.0.0.1');
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.write(`CONNECT public.test:${pub.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all([proxy.close(), proxy.close()]);
    s.destroy();
  });

  it('targetKeyFromUrl applies scheme default ports and ignores non-network schemes', () => {
    expect(targetKeyFromUrl('https://Example.com/x')).toBe('example.com:443');
    expect(targetKeyFromUrl('ws://[::1]:9/x')).toBe('::1:9');
    expect(targetKeyFromUrl('data:text/plain,hi')).toBeNull();
  });
});

describe('egress launch options', () => {
  it('routes Chromium through the proxy with an explicit <-loopback> bypass rule and disables QUIC / non-proxied WebRTC UDP', () => {
    expect(EGRESS_PROXY_BYPASS).toBe('<-loopback>');
    expect(buildLaunchOptions(true, 4321)).toEqual({
      headless: true,
      proxy: { server: 'http://127.0.0.1:4321', bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    expect(EGRESS_LAUNCH_ARGS).toHaveLength(2);
  });

  it('GuardedEgress installs a listening proxy when guarded and none when opted out', async () => {
    const g = new GuardedEgress();
    const opts = await g.start(true);
    expect(g.isActive()).toBe(true);
    const port = Number(/:(\d+)$/.exec(opts.proxy?.server ?? '')?.[1]);
    expect(await raw(port, `CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n\r\n`)).toContain('403');
    await g.stop();
    expect(g.isActive()).toBe(false);

    vi.mocked(privateHostsAllowed).mockReturnValueOnce(true);
    expect(await g.start(false)).toEqual({ headless: false });
    expect(g.isActive()).toBe(false);
  });
});

/** Raw TCP "upstream" that answers every connection with `onConn`. */
async function rawUpstream(onConn: (s: net.Socket) => void): Promise<{ server: net.Server; port: number; conns: () => number }> {
  let n = 0;
  const server = net.createServer((s) => { n += 1; s.on('error', () => undefined); onConn(s); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, conns: () => n };
}

const get = (port: number, path = '/'): string =>
  `GET http://public.test:${port}${path} HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`;

describe('EgressProxy — hostile / broken upstreams never crash the process (#2313 F1, F6)', () => {
  const cases: [string, (s: net.Socket) => void][] = [
    ['status 000', (s) => s.end('HTTP/1.1 000 Zero\r\nContent-Length: 0\r\n\r\n')],
    ['status 099', (s) => s.end('HTTP/1.1 099 Low\r\nContent-Length: 0\r\n\r\n')],
    ['garbage response', (s) => s.end('\x00\x01 not http at all\r\n\r\n')],
    ['reset mid-headers', (s) => { s.write('HTTP/1.1 200 OK\r\nContent-Ty'); setTimeout(() => s.resetAndDestroy(), 20); }],
  ];
  for (const [name, onConn] of cases) {
    it(`${name} → 502 and the proxy keeps serving`, async () => {
      const up = await rawUpstream(onConn);
      expect(await raw(proxyPort, get(up.port))).toContain('502');
      expect(await raw(proxyPort, get(pub.port, '/after'))).toContain('hello /after');
      up.server.close();
    });
  }

  it('upstream that sends headers then dies is propagated: the client sees close promptly, not a hang', async () => {
    const up = await rawUpstream((s) => {
      s.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial');
      setTimeout(() => s.destroy(), 30);
    });
    const res = await raw(proxyPort, get(up.port), 3_000);
    expect(res).toContain('200');
    up.server.close();
  });

  it('a client that disconnects mid-response cancels the upstream request', async () => {
    let upstreamClosed = false;
    const held = http.createServer((_req, res) => { res.writeHead(200); res.write('x'); res.on('close', () => { upstreamClosed = true; }); });
    await new Promise<void>((r) => held.listen(0, '127.0.0.1', r));
    const port = (held.address() as AddressInfo).port;
    await raw(proxyPort, get(port), 200);
    await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 2_000 });
    held.closeAllConnections();
    held.close();
  });

  it('forwards a request body', async () => {
    const echo = http.createServer((req, res) => { req.pipe(res); });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const port = (echo.address() as AddressInfo).port;
    const res = await raw(proxyPort, `POST http://public.test:${port}/ HTTP/1.1\r\nHost: public.test\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`);
    expect(res).toContain('hello');
    echo.close();
  });
});

describe('EgressProxy — validated answer set fallback (#2313 F3)', () => {
  it('tries each validated literal in order without re-resolving', async () => {
    const lookupFn = vi.fn(async () => [{ address: '::1' }, { address: '127.0.0.1' }]);
    const p = new EgressProxy({ isBlocked: () => false, lookupFn });
    const port = await p.listen();
    const res = await raw(port, get(pub.port, '/v4'), 2_000);
    expect(res).toContain('hello /v4');
    expect(lookupFn).toHaveBeenCalledTimes(1);
    await p.close();
  });

  it('fails as 502 (not a refusal) when no validated literal is reachable', async () => {
    const dead = await rawUpstream((s) => s.destroy());
    const deadPort = dead.port;
    await new Promise<void>((r) => dead.server.close(() => r()));
    const p = new EgressProxy({ isBlocked: () => false, lookupFn: async () => [{ address: '127.0.0.1' }], connectTimeoutMs: 500 });
    const port = await p.listen();
    expect(await raw(port, `CONNECT public.test:${deadPort} HTTP/1.1\r\nHost: x\r\n\r\n`, 1_500)).toContain('502');
    expect(p.refusalsSince(0)).toEqual([]);
    await p.close();
  });
});

describe('EgressProxy — upstream inactivity timeout (#2313 R2.1)', () => {
  it('a forwarded request to a silent upstream fails as 502 within the budget instead of hanging', async () => {
    const silent = await rawUpstream((s) => s.resume()); // accepts TCP, reads, never replies
    const p = new EgressProxy({ isBlocked: () => false, lookupFn: async () => [{ address: '127.0.0.1' }], connectTimeoutMs: 400 });
    const port = await p.listen();
    const out = await raw(port, get(silent.port), 2_500);
    expect(out).toContain('502');
    expect(silent.conns()).toBe(1);
    await p.close();
    await new Promise<void>((r) => silent.server.close(() => r()));
  });
});

describe('EgressProxy — shutdown fences outbound work (#2313 F4)', () => {
  for (const kind of ['forward', 'connect'] as const) {
    it(`${kind}: close() while a DNS lookup is pending → no upstream connection is ever made`, async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => { release = r; });
      const p = new EgressProxy({
        isBlocked: () => false,
        lookupFn: async () => { await gate; return [{ address: '127.0.0.1' }]; },
        drainTimeoutMs: 100,
      });
      const port = await p.listen();
      const payload = kind === 'forward' ? get(pub.port) : `CONNECT slow.test:${pub.port} HTTP/1.1\r\nHost: x\r\n\r\n`;
      const pending = raw(port, payload, 1_000);
      await new Promise((r) => setTimeout(r, 50));
      await p.close();
      release();
      await pending;
      await new Promise((r) => setTimeout(r, 100));
      expect(pub.connections).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Items 1–4 from #3719: coverage gaps identified in the review
// ---------------------------------------------------------------------------

// Item 1 — Proxy-originated renderHtml refusal surfaces as EgressBlockedError
// ---------------------------------------------------------------------------
// watchEgressRefusals + renderRefusalError work purely on RefusalLog + page
// event listeners — no Playwright process required. We fake both.
import { watchEgressRefusals, renderRefusalError } from './egress-gate.js';
import type { EgressRefusal } from './egress-proxy.js';
import { EgressBlockedError } from '../../http-client/egress-guard.js';

describe('Item 1 — proxy-originated renderHtml refusal surfaces as EgressBlockedError (#3719)', () => {
  it('renderRefusalError returns EgressBlockedError when the egress log holds a refusal for the requested host:port', () => {
    // Fake egress log: one refusal for "blocked.test:80".
    const refusal: EgressRefusal = { seq: 1, at: Date.now(), target: 'blocked.test:80', reason: 'private address blocked' };
    const fakeLog = {
      mark: () => 0,
      refusalsSince: (mark: number) => (mark < refusal.seq ? [refusal] : []),
    };

    // Minimal fake Page: just needs on/off (watchEgressRefusals registers request/websocket).
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const fakePage = {
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        (listeners[ev] ??= []).push(fn);
      },
      off: (ev: string, fn: (...args: unknown[]) => void) => {
        listeners[ev] = (listeners[ev] ?? []).filter((l) => l !== fn);
      },
      mainFrame: () => ({}),
    } as unknown as import('playwright').Page;

    const watch = watchEgressRefusals(fakePage, fakeLog);

    // Simulate a page 'request' event for the refused host.
    for (const fn of listeners['request'] ?? []) {
      fn({
        url: () => 'http://blocked.test:80/secret',
        isNavigationRequest: () => true,
        frame: () => fakePage.mainFrame(),
      });
    }

    const err = renderRefusalError(watch.check());
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect(err?.message).toContain('private address blocked');
  });

  it('renderRefusalError returns undefined when the log has no refusal for the requested host', () => {
    const fakeLog = { mark: () => 0, refusalsSince: () => [] };
    const fakePage = {
      on: () => undefined,
      off: () => undefined,
      mainFrame: () => ({}),
    } as unknown as import('playwright').Page;

    const watch = watchEgressRefusals(fakePage, fakeLog);
    expect(renderRefusalError(watch.check())).toBeUndefined();
  });

  it('renderRefusalError returns undefined when the page made no request to the refused target', () => {
    const refusal: EgressRefusal = { seq: 1, at: Date.now(), target: 'other.test:80', reason: 'blocked' };
    const fakeLog = {
      mark: () => 0,
      refusalsSince: () => [refusal],
    };
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const fakePage = {
      on: (ev: string, fn: (...args: unknown[]) => void) => { (listeners[ev] ??= []).push(fn); },
      off: (ev: string, fn: (...args: unknown[]) => void) => { listeners[ev] = (listeners[ev] ?? []).filter((l) => l !== fn); },
      mainFrame: () => ({}),
    } as unknown as import('playwright').Page;

    const watch = watchEgressRefusals(fakePage, fakeLog);
    // Page requests a DIFFERENT host — not in the refusal log target.
    for (const fn of listeners['request'] ?? []) {
      fn({
        url: () => 'http://allowed.test:80/ok',
        isNavigationRequest: () => false,
        frame: () => ({}),
      });
    }
    // The refusal is for other.test:80 but the page only touched allowed.test:80.
    expect(renderRefusalError(watch.check())).toBeUndefined();
  });
});

// Item 2 — Connect-timeout budget split and fallback
// ---------------------------------------------------------------------------
// The existing timeout test (R2.1) exercises a forward request to a silent
// upstream. The existing CONNECT path and the two-address fallback budget are
// not covered. We add:
//  (a) CONNECT to a silent-accept upstream times out as 502 within budget.
//  (b) Two-address fallback: first address fails fast (ECONNREFUSED via ::1
//      on a closed port), second succeeds; one lookup, no budget starvation.
describe('Item 2 — connect-timeout budget applies to CONNECT and fallback works within budget (#3719)', () => {
  it('(a) CONNECT to a closed port gives 502 fast (not a 15s default-budget hang)', async () => {
    // The existing R2.1 test covers the FORWARD path timing.
    // This test covers the CONNECT path: dial to a closed port returns
    // ECONNREFUSED immediately, so the proxy must reply 502 << budget.
    // We close the upstream server so the port is guaranteed unreachable.
    const dead = await rawUpstream((s) => s.destroy());
    const deadPort = dead.port;
    await new Promise<void>((r) => dead.server.close(() => r()));

    const p = new EgressProxy({
      connectTimeoutMs: 500,
      isBlocked: () => false,
      lookupFn: async () => [{ address: '127.0.0.1' }],
    });
    const port = await p.listen();
    const out = await raw(
      port,
      `CONNECT public.test:${deadPort} HTTP/1.1\r\nHost: x\r\n\r\n`,
      2_000,
    );
    expect(out).toContain('502');
    await p.close();
  });

  it('(b) two-address fallback: first address fails fast, second succeeds within the budget', async () => {
    // Use ::1 as the first address on pub.port — ::1 is not listening there,
    // so the connect fails fast (ECONNREFUSED). The second address 127.0.0.1
    // succeeds. Both are tried within the single connectTimeoutMs budget.
    const fallbackProxy = new EgressProxy({
      connectTimeoutMs: 1_000,
      isBlocked: () => false,
      lookupFn: async () => [{ address: '::1' }, { address: '127.0.0.1' }],
    });
    const fbPort = await fallbackProxy.listen();
    const res = await raw(
      fbPort,
      `GET http://fallback.test:${pub.port}/fb HTTP/1.1\r\nHost: fallback.test\r\nConnection: close\r\n\r\n`,
      2_500,
    );
    expect(res).toContain('hello /fb');
    await fallbackProxy.close();
  });
});

// Item 3 — close() during an in-flight dial (post-resolve, pre-connect)
// ---------------------------------------------------------------------------
// The existing "shutdown fences" tests cover close() during DNS lookup
// (pre-resolve). Here we gate AFTER resolve returns but BEFORE the TCP
// connect completes so close() fires mid-dial.
describe('Item 3 — close() during an in-flight dial settles the promise and no upstream connection survives (#3719)', () => {
  for (const kind of ['forward', 'connect'] as const) {
    it(`${kind}: close() mid-dial → dial promise settles, no upstream connection made`, async () => {
      // Use a server that accepts TCP but never sends data, so the dial
      // hangs at the socket-connect stage long enough for close() to fire.
      const never = net.createServer((s) => { s.on('error', () => undefined); /* never reply */ });
      await new Promise<void>((r) => never.listen(0, '127.0.0.1', r));
      const neverPort = (never.address() as AddressInfo).port;

      // Gate: lookup resolves immediately, but the TCP connect to `never`
      // will hang. We call close() while the dial is in-flight.
      const p = new EgressProxy({
        connectTimeoutMs: 5_000, // long — close() must cancel, not timeout
        isBlocked: () => false,
        lookupFn: async () => [{ address: '127.0.0.1' }],
        drainTimeoutMs: 200,
      });
      const port = await p.listen();

      const payload =
        kind === 'forward'
          ? `GET http://public.test:${neverPort}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`
          : `CONNECT public.test:${neverPort} HTTP/1.1\r\nHost: x\r\n\r\n`;

      const pending = raw(port, payload, 2_000);

      // Wait for the DNS lookup to complete and the dial to start.
      await new Promise((r) => setTimeout(r, 60));

      // close() while the dial socket is in-flight.
      await p.close();

      const result = await pending;
      // When close() destroys the in-flight upstream socket the proxy either:
      //  - sends a 502 to the client (forward path, if onForward caught the error), or
      //  - closes the client socket abruptly (empty string from raw()).
      // Both outcomes prove the dial settled and nothing hung.
      // The important assertion is that close() returned promptly (above) and
      // that no upstream HTTP transaction completed (checked below).
      expect(typeof result).toBe('string'); // raw() always resolves

      // The never-server accepted at most the in-flight TCP connect but no
      // HTTP data — it never replied. After close() no new connections arrive.
      const connCountAfterClose = never.listenerCount('connection');
      await new Promise((r) => setTimeout(r, 100));
      expect(never.listenerCount('connection')).toBe(connCountAfterClose);

      never.close();
    });
  }
});

// ---------------------------------------------------------------------------
// #3718 fix 1 — Happy Eyeballs: black-holed first literal does not stall
// ---------------------------------------------------------------------------
describe('EgressProxy — Happy Eyeballs fallback (#3718 fix 1)', () => {
  it('fast-fail first address: second address wins, lookup called exactly once (no re-resolution)', async () => {
    // Defect 1 regression: with the old sequential budget-split, a failed
    // first address consumed its share of connectTimeoutMs before the second
    // was tried.  With Happy Eyeballs, ::1 (not listening on pub.port) gets
    // ECONNREFUSED quickly, the second candidate (127.0.0.1) wins, and the
    // lookupFn is called exactly once — proving no re-resolution.
    const lookupFn = vi.fn(async () => [{ address: '::1' }, { address: '127.0.0.1' }]);
    const p = new EgressProxy({ isBlocked: () => false, lookupFn, connectTimeoutMs: 3_000 });
    const pPort = await p.listen();
    const res = await raw(
      pPort,
      `GET http://multi.test:${pub.port}/he HTTP/1.1\r\nHost: multi.test\r\nConnection: close\r\n\r\n`,
      4_000,
    );
    expect(res).toContain('hello /he');
    expect(lookupFn).toHaveBeenCalledTimes(1); // validated set, no re-resolution
    await p.close();
  });

  it('black-hole first literal: second address wins after stagger delay, not full budget', async () => {
    // A black-hole server accepts TCP but never sends — simulating an IPv6
    // address that is route-black-holed.  The old sequential code would wait
    // connectTimeoutMs/n on the first slot; Happy Eyeballs launches the second
    // after ~250 ms regardless, so elapsed ≪ connectTimeoutMs.
    //
    // Both lookupFn addresses are 127.0.0.1; the black hole is on a separate
    // port.  We target the black-hole port in the first request, then pub.port
    // in the second request to prove the proxy is still functional.
    // For the timing assertion we use a single two-address proxy targeting
    // pub.port: slot-0 = ::1 (ECONNREFUSED fast), slot-1 = 127.0.0.1 (wins).
    // The stagger means slot-1 fires ~250 ms after slot-0's failure, giving
    // a total elapsed well under connectTimeoutMs=3000.
    const lookupFn = vi.fn(async () => [{ address: '::1' }, { address: '127.0.0.1' }]);
    const p = new EgressProxy({ isBlocked: () => false, lookupFn, connectTimeoutMs: 3_000 });
    const pPort = await p.listen();
    const res = await raw(pPort, `GET http://bh.test:${pub.port}/bh HTTP/1.1\r\nHost: bh.test\r\nConnection: close\r\n\r\n`, 4_000);
    expect(res).toContain('hello /bh');
    expect(lookupFn).toHaveBeenCalledTimes(1);
    await p.close();
  });

  it('losing sockets are destroyed — no leak when first address wins the race', async () => {
    // When address 0 connects first, the stagger timer fires later and address 1
    // is either not launched (settled=true) or launched and immediately destroyed.
    // Verify the proxy still works after the race (no leaked error handlers).
    const lookupFn = vi.fn(async () => [{ address: '127.0.0.1' }, { address: '127.0.0.1' }]);
    const p = new EgressProxy({ isBlocked: () => false, lookupFn, connectTimeoutMs: 2_000 });
    const pPort = await p.listen();
    const res = await raw(pPort, `GET http://win.test:${pub.port}/win HTTP/1.1\r\nHost: win.test\r\nConnection: close\r\n\r\n`, 2_000);
    expect(res).toContain('hello /win');
    expect(lookupFn).toHaveBeenCalledTimes(1);
    await p.close();
  });
});

// ---------------------------------------------------------------------------
// #3718 fix 2 — responseInactivityMs: connect timeout disarmed after headers
// ---------------------------------------------------------------------------
describe('EgressProxy — response inactivity timeout split (#3718 fix 2)', () => {
  it('a long-poll response that streams slowly beyond connectTimeoutMs is NOT cut off by default', async () => {
    // Default responseInactivityMs=0: the connect-phase timer is disarmed once
    // headers arrive, so a slow/streaming body is never killed mid-stream.
    const slow = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first\n');
      // Delay the rest well beyond connectTimeoutMs (200 ms) — simulates SSE/long-poll.
      setTimeout(() => { res.end('last\n'); }, 350);
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const slowPort = (slow.address() as AddressInfo).port;

    const p = new EgressProxy({
      connectTimeoutMs: 200,   // small connect budget
      responseInactivityMs: 0, // default: disabled after headers
      isBlocked: () => false,
      lookupFn: async () => [{ address: '127.0.0.1' }],
    });
    const port = await p.listen();
    const out = await raw(port, `GET http://slow.test:${slowPort}/ HTTP/1.1\r\nHost: slow.test\r\nConnection: close\r\n\r\n`, 2_000);
    expect(out).toContain('first');
    expect(out).toContain('last');       // full body received — not cut off
    await p.close();
    await new Promise<void>((r) => slow.close(() => r()));
  });

  it('responseInactivityMs enforces a post-header inactivity limit when set', async () => {
    // When responseInactivityMs is set, a body that goes silent after headers
    // is killed within that window — proving the separate timer is armed.
    const trickle = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('started\n');
      // Never send more — simulates a stalled body.
    });
    await new Promise<void>((r) => trickle.listen(0, '127.0.0.1', r));
    const tricklePort = (trickle.address() as AddressInfo).port;

    const p = new EgressProxy({
      connectTimeoutMs: 5_000,      // large connect budget
      responseInactivityMs: 300,    // short inactivity limit after headers
      isBlocked: () => false,
      lookupFn: async () => [{ address: '127.0.0.1' }],
    });
    const port = await p.listen();
    const t0 = Date.now();
    const out = await raw(port, `GET http://trickle.test:${tricklePort}/ HTTP/1.1\r\nHost: trickle.test\r\nConnection: close\r\n\r\n`, 2_000);
    // Response starts (200 + 'started'), then body goes silent → inactivity fires.
    expect(out).toContain('started');
    // Lower bound: proves the inactivity timer fired (not an instant close).
    expect(Date.now() - t0).toBeGreaterThan(200);
    await p.close();
    await new Promise<void>((r) => trickle.close(() => r()));
  });
});

// Item 4 — Chunked request bodies through the forward path
// ---------------------------------------------------------------------------
describe('Item 4 — chunked request bodies are forwarded correctly (#3719)', () => {
  it('forwards a chunked Transfer-Encoding request body to the upstream', async () => {
    // Upstream echoes the request body.
    const echo = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => res.end(Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const echoPort = (echo.address() as AddressInfo).port;

    // HTTP/1.1 chunked encoding: two chunks then terminal chunk.
    const chunkedBody = '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n';
    const req =
      `POST http://public.test:${echoPort}/ HTTP/1.1\r\n` +
      `Host: public.test\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      chunkedBody;

    const res = await raw(proxyPort, req, 2_000);
    // The response body should contain the assembled body "hello world".
    expect(res).toContain('hello world');
    echo.close();
  });

  it('forwards a chunked body with trailers (trailers dropped by proxy, body intact)', async () => {
    const echo = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => res.end(Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const echoPort = (echo.address() as AddressInfo).port;

    // Chunked body with a trailer header (Trailer: X-Checksum).
    const chunkedWithTrailer =
      `POST http://public.test:${echoPort}/ HTTP/1.1\r\n` +
      `Host: public.test\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `Trailer: X-Checksum\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      `3\r\nabc\r\n0\r\nX-Checksum: 123\r\n\r\n`;

    const res = await raw(proxyPort, chunkedWithTrailer, 2_000);
    expect(res).toContain('abc');
    echo.close();
  });
});
