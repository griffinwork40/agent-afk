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
import { buildLaunchOptions, EGRESS_LAUNCH_ARGS, GuardedEgress } from './egress-launch.js';

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
    const t0 = Date.now();
    await Promise.all([proxy.close(), proxy.close()]);
    expect(Date.now() - t0).toBeLessThan(2_000);
    s.destroy();
  });

  it('targetKeyFromUrl applies scheme default ports and ignores non-network schemes', () => {
    expect(targetKeyFromUrl('https://Example.com/x')).toBe('example.com:443');
    expect(targetKeyFromUrl('ws://[::1]:9/x')).toBe('::1:9');
    expect(targetKeyFromUrl('data:text/plain,hi')).toBeNull();
  });
});

describe('egress launch options', () => {
  it('routes Chromium through the proxy with no extra bypass and disables QUIC / non-proxied WebRTC UDP', () => {
    expect(buildLaunchOptions(true, 4321)).toEqual({
      headless: true,
      proxy: { server: 'http://127.0.0.1:4321', bypass: '' },
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
