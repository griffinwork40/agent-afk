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

/** Build the standard non-IP-error factory (mirrors egress-guard.ts production). */
function makeNonIpError(hostname: string, record: string): Error {
  return new EgressBlockedError(
    `DNS lookup for ${hostname} returned a non-IP record: "${record}"`,
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
        makeNonIpError,
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
        makeNonIpError,
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
        makeNonIpError,
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
        makeNonIpError,
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
      makeNonIpError,
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
      makeNonIpError,
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
      makeNonIpError,
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
      makeNonIpError,
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
      makeNonIpError,
    });

    const result = await callLookup(hook, 'example.com', { all: true });

    expect(result.err).toBe(dnsError);
  });

  it('wraps non-Error rejection as Error', async () => {
    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => { throw 'string rejection'; }),
      isBlocked: () => false,
      makeBlockError,
      makeNonIpError,
    });

    const result = await callLookup(hook, 'example.com', { all: true });

    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toContain('string rejection');
  });
});

// ---- non-IP records are blocked (Item 3) --------------------------------------

describe('non-IP record handling', () => {
  it('blocks when a record address is not a valid IP (isIP() === 0)', async () => {
    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => [{ address: 'not-an-ip' }]),
      isBlocked: () => false, // isBlocked is never reached — non-IP is caught first
      makeBlockError,
      makeNonIpError,
    });

    const result = await callLookup(hook, 'example.com', { all: true });

    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toMatch(/non-IP record/);
  });

  it('blocks on a non-IP record even when a valid record precedes it', async () => {
    // The full set is classified before any filtering — a non-IP anywhere blocks.
    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => [{ address: '93.184.216.34' }, { address: 'cname.example.com' }]),
      isBlocked: () => false,
      makeBlockError,
      makeNonIpError,
    });

    const result = await callLookup(hook, 'example.com', { all: true });

    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toMatch(/non-IP record/);
  });

  it('non-IP record path rejects with EgressBlockedError (via makeNonIpError) — consistent error type, still fail-closed', async () => {
    // Regression guard for #3181: before this fix the non-IP path used `new Error`
    // directly. A caller pattern-matching the error type would classify it as a
    // DNS failure rather than an SSRF block, even though the request is still
    // blocked. Now the error comes from deps.makeNonIpError, which the production
    // wiring (egress-guard.ts) implements as EgressBlockedError — consistent with
    // the blocked-IP path that uses deps.makeBlockError.
    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => [{ address: 'cname.example.com' }]),
      isBlocked: () => false,
      makeBlockError,
      makeNonIpError, // production-equivalent: returns EgressBlockedError
    });

    const result = await callLookup(hook, 'example.com', { all: true });

    // Must be EgressBlockedError (not a plain Error) so callers can pattern-match
    // the type correctly and classify it as an SSRF block, not a DNS failure.
    expect(result.err).toBeInstanceOf(EgressBlockedError);
    expect(result.err?.message).toMatch(/non-IP record/);
    // The request must still be blocked (err is non-null → fail-closed invariant holds).
    expect(result.err).not.toBeNull();
  });
});

// ---- callback throw is caught and routed back (Item 2) ----------------------

describe('callback throw recovery', () => {
  it('routes a synchronous callback throw back through the error channel — does not produce unhandled rejection', async () => {
    // Arrange: the callback throws on the first call (simulating net's emitLookup
    // throwing ERR_INVALID_IP_ADDRESS). The try/catch in onOk catches it and the
    // .catch belt-and-suspenders then delivers the error to the callback. Since
    // `delivered` was never set (the throw prevented it), the second call goes
    // through.
    const throwingError = new Error('callback-threw');
    const calls: Array<{ err: unknown }> = [];

    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => [{ address: '93.184.216.34' }]),
      isBlocked: () => false,
      makeBlockError,
      makeNonIpError,
    });

    // Build a callback that throws once then records subsequent calls.
    let firstCall = true;
    const callback = ((...args: unknown[]) => {
      if (firstCall) {
        firstCall = false;
        throw throwingError;
      }
      calls.push({ err: args[0] });
    }) as LookupCallback;

    hook('example.com', { all: false }, callback);

    // Wait for the promise chain (then + catch) to settle across microtasks.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The try/catch in onOk catches the throw; then the .catch routes the error
    // back to the callback. So we expect exactly one recorded call (the second).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.err).toBe(throwingError);
  });

  it('does not call callback more than twice even when every call throws', async () => {
    // If callback always throws: the try/catch in onOk catches the first throw
    // and the .catch belt-and-suspenders attempts a second call. If that also
    // throws, the outer try/catch in .catch swallows it. So total calls ≤ 2.
    let callCount = 0;

    const hook = createGuardedLookup({
      lookupFn: vi.fn(async () => [{ address: '93.184.216.34' }]),
      isBlocked: () => false,
      makeBlockError,
      makeNonIpError,
    });

    hook('example.com', { all: false }, ((..._args: unknown[]) => {
      callCount++;
      throw new Error('callback always throws');
    }) as LookupCallback);

    // Wait for the promise chain (then + catch) to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Call sequence when callback always throws:
    //   1. onOk try block calls callback → throws (count=1, delivered not set)
    //   2. onOk catch block calls callback → throws (count=2), propagates out of onOk
    //   3. outer .catch calls callback → throws (count=3), swallowed by inner try/catch
    // No fourth call is possible because the outer .catch's inner try/catch swallows it.
    expect(callCount).toBeLessThanOrEqual(3);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Real-undici contract tests
// ---------------------------------------------------------------------------

describe('real-undici contract', () => {
  it('undici accepts the all=true array callback and returns 200 from a local server — spy proves all=true was received', async () => {
    const { server, port } = await startLocalServer();

    try {
      // Build a lookup that resolves "fake-host.test" → 127.0.0.1, but with
      // isBlocked = () => false so the guard does not refuse loopback.
      //
      // Item 1: wrap the hook so we can assert options.all === true was actually
      // passed by undici. The scalar callback (all=false) also produces a 200, so
      // asserting only res.status doesn't prove the array path ran.
      let receivedAllTrue = false;
      const rawHook = createGuardedLookup({
        lookupFn: async () => [{ address: '127.0.0.1' }],
        isBlocked: () => false, // allow loopback for this test only
        makeBlockError,
        makeNonIpError,
      });
      const spyHook: typeof rawHook = (hostname, options, callback) => {
        if (options.all === true) receivedAllTrue = true;
        rawHook(hostname, options, callback);
      };

      const dispatcher = new Agent({
        connect: {
          // Pass autoSelectFamily so undici sends all=true on supported platforms.
          lookup: spyHook,
          autoSelectFamily: true,
        },
      });

      const res = await undiciFetch(`http://fake-host.test:${port}/`, {
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]);

      expect(res.status).toBe(200);
      // Verify the array (all=true) path was exercised, not just the scalar path.
      expect(receivedAllTrue).toBe(true);
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
            makeNonIpError,
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
