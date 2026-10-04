/**
 * Unit tests for egress-guard.lookup.ts — the `createGuardedLookup` factory.
 *
 * Strategy:
 *  - Unit tests inject all dependencies (lookupFn, isBlocked, makeBlockError)
 *    so no real DNS or sockets are opened.
 *  - Two real-undici contract tests start a local HTTP server on 127.0.0.1:0
 *    to prove the callback shape is accepted by undici, using a loopback
 *    address that the SSRF guard would normally block (bypassed by using
 *    isBlocked = () => false for the happy path).
 *  - No platform-specific skips: the local server binds to 127.0.0.1 which
 *    is available on POSIX and Windows alike.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { createGuardedLookup, type LookupOptions, type LookupCallback } from './egress-guard.lookup.js';
import { EgressBlockedError } from './egress-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a lookupFn that resolves to the given address strings. */
function fixedLookup(...addresses: string[]) {
  return vi.fn(async () => addresses.map((address) => ({ address })));
}

/** Build the standard block-error factory (mirrors egress-guard.ts production). */
function makeBlockError(hostname: string, blockedAddress: string): Error {
  return new EgressBlockedError(
    `refusing to connect to ${hostname} (resolved) — internal/private address ` +
      `${blockedAddress} (loopback, link-local, cloud metadata, or RFC1918 space). ` +
      'Set AFK_WEB_ALLOW_PRIVATE_HOSTS=1 to allow private-host access.',
  );
}

/** Call the lookup hook and await its callback result. */
function callLookup(
  hookFn: (hostname: string, options: LookupOptions, callback: LookupCallback) => void,
  hostname: string,
  options: LookupOptions,
): Promise<{ err: Error | null; addresses?: { address: string; family: number }[]; address?: string; family?: number }> {
  return new Promise((resolve) => {
    hookFn(hostname, options, ((...args: unknown[]) => {
      const [err, second, third] = args;
      if (err instanceof Error) {
        resolve({ err });
      } else if (Array.isArray(second)) {
        resolve({ err: null, addresses: second as { address: string; family: number }[] });
      } else {
        resolve({ err: null, address: second as string, family: third as number });
      }
    }) as LookupCallback);
  });
}

/** Start a minimal HTTP server on 127.0.0.1 and return its port. */
function startLocalServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('createGuardedLookup', () => {
  afterEach(() => vi.restoreAllMocks());

  // ---- all=true callback shape ------------------------------------------------

  describe('all=true (undici autoSelectFamily mode)', () => {
    it('returns an array of {address, family} records when all records pass', async () => {
      const hook = createGuardedLookup({
        lookupFn: fixedLookup('93.184.216.34', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'),
        isBlocked: () => false,
        makeBlockError,
      });

      const result = await callLookup(hook, 'example.com', { all: true });

      expect(result.err).toBeNull();
      expect(result.addresses).toHaveLength(2);
      expect(result.addresses![0]).toEqual({ address: '93.184.216.34', family: 4 });
      expect(result.addresses![1]).toEqual({ address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 });
    });

    it('blocks when any address in the set is private — even if all=true', async () => {
      const hook = createGuardedLookup({
        lookupFn: fixedLookup('93.184.216.34', '::1'), // mixed public + private
        isBlocked: (ip) => ip === '::1',
        makeBlockError,
      });

      const result = await callLookup(hook, 'example.com', { all: true });

      expect(result.err).toBeInstanceOf(EgressBlockedError);
    });
  });

  // ---- all=false callback shape -----------------------------------------------

  describe('all=false (classic single-address mode)', () => {
    it('returns (address, family) scalars when all records pass', async () => {
      const hook = createGuardedLookup({
        lookupFn: fixedLookup('93.184.216.34'),
        isBlocked: () => false,
        makeBlockError,
      });

      const result = await callLookup(hook, 'example.com', { all: false });

      expect(result.err).toBeNull();
      expect(result.address).toBe('93.184.216.34');
      expect(result.family).toBe(4);
    });

    it('blocks on a private address in all=false mode', async () => {
      const hook = createGuardedLookup({
        lookupFn: fixedLookup('127.0.0.1'),
        isBlocked: (ip) => ip === '127.0.0.1',
        makeBlockError,
      });

      const result = await callLookup(hook, 'internal.example', { all: false });

      expect(result.err).toBeInstanceOf(EgressBlockedError);
    });
  });

  // ---- Invariant: classify the FULL set before filtering ---------------------

  it('blocks when a private address exists even if family filter would exclude it', async () => {
    // records: [public v4, ::1 (private v6)], family filter = 4
    // If filtering ran FIRST, ::1 would be removed and the request would succeed.
    // Contract: classify the FULL set first → block.
    const hook = createGuardedLookup({
      lookupFn: fixedLookup('93.184.216.34', '::1'),
      isBlocked: (ip) => ip === '::1',
      makeBlockError,
    });

    const result = await callLookup(hook, 'example.com', { all: true, family: 4 });

    expect(result.err).toBeInstanceOf(EgressBlockedError);
  });

  // ---- family filter applied after classification ----------------------------

  it('filters to family:4 after all records pass classification', async () => {
    const hook = createGuardedLookup({
      lookupFn: fixedLookup('93.184.216.34', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'),
      isBlocked: () => false,
      makeBlockError,
    });

    const result = await callLookup(hook, 'example.com', { all: true, family: 4 });

    expect(result.err).toBeNull();
    expect(result.addresses).toHaveLength(1);
    expect(result.addresses![0]!.family).toBe(4);
  });

  it('filters to family:6 after all records pass classification', async () => {
    const hook = createGuardedLookup({
      lookupFn: fixedLookup('93.184.216.34', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'),
      isBlocked: () => false,
      makeBlockError,
    });

    const result = await callLookup(hook, 'example.com', { all: true, family: 6 });

    expect(result.err).toBeNull();
    expect(result.addresses).toHaveLength(1);
    expect(result.addresses![0]!.family).toBe(6);
  });

  it('errors (not empty array) when family filter leaves zero records', async () => {
    const hook = createGuardedLookup({
      lookupFn: fixedLookup('93.184.216.34'), // only v4
      isBlocked: () => false,
      makeBlockError,
    });

    // Request family:6 — no v6 records → should error, not return []
    const result = await callLookup(hook, 'example.com', { all: true, family: 6 });

    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toMatch(/no addresses matching family/);
  });

  // ---- DNS error passthrough -------------------------------------------------

  it('passes DNS errors through unchanged', async () => {
    const dnsError = Object.assign(new Error('ENOTFOUND example.com'), { code: 'ENOTFOUND' });
    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => { throw dnsError; }),
      isBlocked: () => false,
      makeBlockError,
    });

    const result = await callLookup(hook, 'example.com', { all: true });

    expect(result.err).toBe(dnsError);
  });

  it('wraps non-Error rejection as Error', async () => {
    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => { throw 'string rejection'; }),
      isBlocked: () => false,
      makeBlockError,
    });

    const result = await callLookup(hook, 'example.com', { all: true });

    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toContain('string rejection');
  });
});

// ---------------------------------------------------------------------------
// Real-undici contract tests
// ---------------------------------------------------------------------------

describe('real-undici contract', () => {
  it('undici accepts the all=true array callback and returns 200 from a local server', async () => {
    const { server, port } = await startLocalServer();

    try {
      // Build a lookup that resolves "fake-host.test" → 127.0.0.1, but with
      // isBlocked = () => false so the guard does not refuse loopback.
      const dispatcher = new Agent({
        connect: {
          lookup: createGuardedLookup({
            lookupFn: async () => [{ address: '127.0.0.1' }],
            isBlocked: () => false, // allow loopback for this test only
            makeBlockError,
          }),
        },
      });

      const res = await undiciFetch(`http://fake-host.test:${port}/`, {
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]);

      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('undici rejects with EgressBlockedError (as cause) when resolution is blocked', async () => {
    const { server, port } = await startLocalServer();

    try {
      const dispatcher = new Agent({
        connect: {
          lookup: createGuardedLookup({
            lookupFn: async () => [{ address: '127.0.0.1' }],
            isBlocked: () => true, // always block
            makeBlockError,
          }),
        },
      });

      await expect(
        undiciFetch(`http://fake-host.test:${port}/`, { dispatcher } as Parameters<typeof undiciFetch>[1]),
      ).rejects.toSatisfy((err: unknown) => {
        // undici wraps connect-time errors as TypeError('fetch failed', { cause })
        if (!(err instanceof Error)) return false;
        const cause = (err as { cause?: unknown }).cause;
        return cause instanceof EgressBlockedError;
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
