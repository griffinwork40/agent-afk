/**
 * Guarded egress proxy for Playwright Chromium (#2301, ADR 20261014 PATH_B).
 * Refusals go to a bounded log keyed by `host:port` so the provider can
 * attribute them (egress-attribution.ts) without parsing Chromium errors.
 */

// Invariant: every TCP connection this proxy opens goes to an address that was
// classified by the shared SSRF classifier immediately before the connect, and
// the connect uses that validated IP literal — no second DNS resolution.
// Hostnames go through createGuardedLookup (full answer set, fail closed, mixed
// public/private refused); IP literals are classified explicitly because
// net.connect skips lookup hooks for literals. Chromium is launched with this
// proxy and Playwright appends <-loopback> to the bypass list, so redirect
// hops, subresources, iframes and websockets all funnel through here. TLS is
// tunnelled opaquely via CONNECT; there is no MITM.

import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Duplex } from 'node:stream';
import { createGuardedLookup } from '../../http-client/egress-guard.lookup.js';
import { EgressBlockedError, isBlockedAddress } from '../../http-client/egress-guard.js';

/** One refused connection attempt. */
export interface EgressRefusal {
  seq: number;
  at: number;
  /** Normalised `host:port` the browser asked for (see {@link targetKey}). */
  target: string;
  reason: string;
}

/** Injectable seams — tests classify by port because CI only has 127.0.0.1. */
export interface EgressProxyDeps {
  lookupFn?: (hostname: string) => Promise<readonly { address: string }[]>;
  isBlocked?: (ip: string, port: number) => boolean;
  /** Upstream connect timeout; a hung target must not hang a tool call. */
  connectTimeoutMs?: number;
  /** Bounded drain window for close(). */
  drainTimeoutMs?: number;
}

const MAX_REFUSALS = 256;
const HOP_HEADERS = new Set(['proxy-connection', 'proxy-authorization', 'keep-alive']);
const FORWARD_DROP = new Set([...HOP_HEADERS, 'connection']);

/** Normalise a host/port pair to the key used for refusal attribution. */
export function targetKey(host: string, port: number | string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return `${h}:${String(port)}`;
}

/** Key for a URL (default ports by scheme); `null` for non-network schemes. */
export function targetKeyFromUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const defaults: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };
  const def = defaults[u.protocol];
  if (def === undefined) return null;
  return targetKey(u.hostname, u.port !== '' ? u.port : def);
}

function refusalMessage(host: string, address: string): string {
  return (
    `refusing browser connection to ${host} — internal/private address ${address} ` +
    '(loopback, link-local, cloud metadata, or RFC1918 space). ' +
    'Set AFK_WEB_ALLOW_PRIVATE_HOSTS=1 to allow private-host access.'
  );
}

/** Split a CONNECT authority (`host:port`, `[v6]:port`). */
function splitAuthority(authority: string): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(authority);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

export class EgressProxy {
  private readonly server: http.Server;
  private readonly sockets = new Set<Duplex>();
  private readonly refusals: EgressRefusal[] = [];
  private seq = 0;
  private closing: Promise<void> | undefined;
  private readonly lookupFn: (hostname: string) => Promise<readonly { address: string }[]>;
  private readonly isBlocked: (ip: string, port: number) => boolean;
  private readonly connectTimeoutMs: number;
  private readonly drainTimeoutMs: number;

  constructor(deps: EgressProxyDeps = {}) {
    this.lookupFn = deps.lookupFn ?? ((h) => lookup(h, { all: true, verbatim: true }));
    this.isBlocked = deps.isBlocked ?? ((ip) => isBlockedAddress(ip));
    this.connectTimeoutMs = deps.connectTimeoutMs ?? 15_000;
    this.drainTimeoutMs = deps.drainTimeoutMs ?? 1_000;
    this.server = http.createServer((req, res) => void this.onForward(req, res));
    this.server.on('connect', (req: http.IncomingMessage, sock: Duplex, head: Buffer) => {
      void this.onTunnel(req, sock, head, 'connect');
    });
    this.server.on('upgrade', (req: http.IncomingMessage, sock: Duplex, head: Buffer) => {
      void this.onTunnel(req, sock, head, 'upgrade');
    });
    this.server.on('connection', (s: net.Socket) => this.track(s));
    this.server.on('clientError', (_err, s: Duplex) => s.destroy());
  }

  /** Bind 127.0.0.1 on an ephemeral port; resolves once listening. */
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.server.unref();
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('egress proxy: no port');
    return addr.port;
  }

  /** Monotonic cursor for {@link refusalsSince}. */
  mark(): number {
    return this.seq;
  }

  /** Refusals recorded after `mark` (oldest first). */
  refusalsSince(mark: number): EgressRefusal[] {
    return this.refusals.filter((r) => r.seq > mark);
  }

  /**
   * Resolve + classify a target. Literal → classified directly; hostname →
   * full answer set via createGuardedLookup. Throws EgressBlockedError (and
   * records it) on refusal; returns the validated IP to connect to.
   */
  async resolve(host: string, port: number): Promise<string> {
    const bare = host.replace(/^\[|\]$/g, '');
    try {
      if (net.isIP(bare) !== 0) {
        if (this.isBlocked(bare, port)) throw new EgressBlockedError(refusalMessage(host, bare));
        return bare;
      }
      return await this.lookupGuarded(bare, port);
    } catch (err) {
      if (err instanceof EgressBlockedError) this.record(targetKey(bare, port), err.message);
      throw err;
    }
  }

  private lookupGuarded(host: string, port: number): Promise<string> {
    const guarded = createGuardedLookup({
      lookupFn: this.lookupFn,
      isBlocked: (ip) => this.isBlocked(ip, port),
      makeBlockError: (h, a) => new EgressBlockedError(refusalMessage(h, a)),
      makeNonIpError: (h, r) => new EgressBlockedError(`DNS lookup for ${h} returned a non-IP record: "${r}"`),
    });
    return new Promise<string>((resolve, reject) => {
      guarded(host, { all: true }, ((err: Error | null, addrs: unknown) => {
        if (err !== null) return reject(err);
        const first = (addrs as { address: string }[])[0];
        if (first === undefined) return reject(new Error(`DNS lookup for ${host} returned no addresses`));
        resolve(first.address);
      }) as Parameters<typeof guarded>[2]);
    });
  }

  private record(target: string, reason: string): void {
    this.seq += 1;
    this.refusals.push({ seq: this.seq, at: Date.now(), target, reason });
    if (this.refusals.length > MAX_REFUSALS) this.refusals.shift();
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.once('close', () => this.sockets.delete(s));
  }

  /** Open a TCP connection to an already-validated IP literal. */
  private dial(address: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const up = net.connect({ host: address, port });
      this.track(up);
      up.setTimeout(this.connectTimeoutMs, () => up.destroy(new Error('egress proxy: upstream timeout')));
      up.once('connect', () => {
        up.setTimeout(0);
        resolve(up);
      });
      up.once('error', reject);
    });
  }

  /** Plain-HTTP forward request (`GET http://host/path`). */
  private async onForward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error('unsupported scheme');
    } catch {
      res.writeHead(400).end('egress proxy: absolute http:// URL required');
      return;
    }
    const port = url.port !== '' ? Number(url.port) : 80;
    let address: string;
    try {
      address = await this.resolve(url.hostname, port);
    } catch (err) {
      res.writeHead(err instanceof EgressBlockedError ? 403 : 502, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? err.message : 'egress proxy error');
      return;
    }
    const headers = { ...req.headers };
    for (const h of FORWARD_DROP) delete headers[h];
    const upstream = http.request({
      host: address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, agent: false,
      timeout: this.connectTimeoutMs,
    });
    upstream.on('socket', (s) => this.track(s));
    upstream.on('timeout', () => upstream.destroy(new Error('egress proxy: upstream timeout')));
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, up.rawHeaders);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('egress proxy: upstream error');
      else res.destroy();
    });
    req.pipe(upstream);
  }

  /** CONNECT tunnel (opaque TLS) or HTTP Upgrade (ws:// forwarded request). */
  private async onTunnel(req: http.IncomingMessage, sock: Duplex, head: Buffer, kind: 'connect' | 'upgrade'): Promise<void> {
    this.track(sock);
    sock.on('error', () => sock.destroy());
    let host: string;
    let port: number;
    let path = '';
    if (kind === 'connect') {
      const auth = splitAuthority(req.url ?? '');
      if (auth === null) return void sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      ({ host, port } = auth);
    } else {
      let u: URL;
      try {
        u = new URL(req.url ?? '');
      } catch {
        return void sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
      host = u.hostname;
      port = u.port !== '' ? Number(u.port) : 80;
      path = `${u.pathname}${u.search}`;
    }
    let up: net.Socket;
    try {
      up = await this.dial(await this.resolve(host, port), port);
    } catch (err) {
      const status = err instanceof EgressBlockedError ? '403 Forbidden' : '502 Bad Gateway';
      return void sock.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    }
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
    up.on('close', () => sock.destroy());
    if (kind === 'connect') {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    } else {
      const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? '';
        if (!HOP_HEADERS.has(name.toLowerCase())) lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ''}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
    }
    if (head.length > 0) up.write(head);
    sock.pipe(up);
    up.pipe(sock);
  }

  /** Stop listening and drain sockets; force-destroys after the drain window. Idempotent. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const s of this.sockets) s.destroy();
        resolve();
      }, this.drainTimeoutMs);
      timer.unref();
      for (const s of this.sockets) s.end();
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.closing;
  }
}
