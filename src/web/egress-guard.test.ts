/**
 * Unit tests for the SSRF egress guard (src/web/egress-guard.ts).
 *
 * Strategy: inject `lookupFn` so no real DNS is issued, and inject `fetchFn`
 * into `guardedFetch` so no real socket is opened. The behaviours under test are
 * the per-range classification, the DNS-rebinding guard (hostname resolving to
 * internal space), per-redirect-hop re-validation, and the env opt-out.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertEgressAllowed,
  checkEgressTarget,
  guardedFetch,
  privateHostsAllowed,
  EgressBlockedError,
} from './egress-guard.js';

/** A lookupFn that resolves every hostname to the given addresses. */
function fixedLookup(...addresses: string[]) {
  return vi.fn(async () => addresses.map((address) => ({ address })));
}

/** A lookupFn that always resolves to a public address (never blocked). */
const publicLookup = fixedLookup('93.184.216.34');

/** Never called — asserts a code path classified an IP literal without DNS. */
const throwingLookup = vi.fn(async () => {
  throw new Error('lookupFn must not be called for an IP literal');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checkEgressTarget — blocked IPv4 ranges', () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ['loopback 127.0.0.1', 'http://127.0.0.1/'],
    ['loopback elsewhere in 127/8', 'http://127.9.9.9/'],
    ['0.0.0.0 (RFC1122 this-network)', 'http://0.0.0.0/'],
    ['0.0.0.0/8 member', 'http://0.1.2.3/'],
    ['cloud metadata 169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
    ['link-local 169.254/16', 'http://169.254.1.1/'],
    ['RFC1918 10/8', 'http://10.0.0.1/'],
    ['RFC1918 172.16/12 low', 'http://172.16.0.1/'],
    ['RFC1918 172.16/12 high', 'http://172.31.255.255/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['carrier-grade NAT 100.64/10', 'http://100.64.0.1/'],
  ];

  for (const [label, url] of blocked) {
    it(`blocks ${label}`, async () => {
      const v = await checkEgressTarget(url, { lookupFn: throwingLookup });
      expect(v.allowed).toBe(false);
      expect(v.allowed === false && v.reason).toMatch(/internal\/private address/);
    });
  }

  it('names the offending address and the opt-out in the refusal', async () => {
    const v = await checkEgressTarget('http://169.254.169.254/', { lookupFn: throwingLookup });
    expect(v.allowed === false && v.reason).toContain('169.254.169.254');
    expect(v.allowed === false && v.reason).toContain('AFK_WEB_ALLOW_PRIVATE_HOSTS');
  });

  it('classifies IP literals without issuing DNS', async () => {
    await checkEgressTarget('http://10.0.0.1/', { lookupFn: throwingLookup });
    expect(throwingLookup).not.toHaveBeenCalled();
  });
});

describe('checkEgressTarget — blocked IPv6 ranges', () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ['loopback ::1', 'http://[::1]/'],
    ['unspecified ::', 'http://[::]/'],
    ['ULA fc00::/7 (fc)', 'http://[fc00::1]/'],
    ['ULA fc00::/7 (fd)', 'http://[fd12:3456::1]/'],
    ['link-local fe80::/10', 'http://[fe80::1]/'],
    ['IPv4-compatible ::127.0.0.1', 'http://[::7f00:1]/'],
    ['NAT64 64:ff9b::/96 embedding loopback', 'http://[64:ff9b::7f00:1]/'],
  ];

  for (const [label, url] of blocked) {
    it(`blocks ${label}`, async () => {
      const v = await checkEgressTarget(url, { lookupFn: throwingLookup });
      expect(v.allowed).toBe(false);
    });
  }

  const mapped: ReadonlyArray<readonly [string, string]> = [
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped metadata IP', 'http://[::ffff:169.254.169.254]/'],
    ['IPv4-mapped RFC1918', 'http://[::ffff:10.0.0.1]/'],
    ['IPv4-mapped RFC1918 (hex form)', 'http://[::ffff:c0a8:1]/'],
  ];

  for (const [label, url] of mapped) {
    it(`blocks ${label}`, async () => {
      const v = await checkEgressTarget(url, { lookupFn: throwingLookup });
      expect(v.allowed).toBe(false);
    });
  }

  it('allows a public IPv6 literal', async () => {
    const v = await checkEgressTarget('http://[2606:4700::1111]/', { lookupFn: throwingLookup });
    expect(v.allowed).toBe(true);
  });

  it('allows an IPv4-mapped PUBLIC address', async () => {
    const v = await checkEgressTarget('http://[::ffff:8.8.8.8]/', { lookupFn: throwingLookup });
    expect(v.allowed).toBe(true);
  });
});

describe('checkEgressTarget — public targets and near-miss boundaries', () => {
  const allowed = [
    'http://8.8.8.8/',
    'https://1.1.1.1/',
    'http://172.15.0.1/', // just below 172.16/12
    'http://172.32.0.1/', // just above 172.16/12
    'http://11.0.0.1/', // just above 10/8
    'http://100.63.255.255/', // just below 100.64/10
    'http://100.128.0.1/', // just above 100.64/10
  ];

  for (const url of allowed) {
    it(`allows ${url}`, async () => {
      const v = await checkEgressTarget(url, { lookupFn: throwingLookup });
      expect(v.allowed).toBe(true);
    });
  }

  it('allows a hostname resolving to a public address', async () => {
    const v = await checkEgressTarget('https://example.com/a', { lookupFn: publicLookup });
    expect(v.allowed).toBe(true);
  });

  it('rejects a non-http(s) scheme', async () => {
    const v = await checkEgressTarget('file:///etc/passwd', { lookupFn: throwingLookup });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/not supported \(http\/https only\)/);
  });

  it('rejects an unparseable URL', async () => {
    const v = await checkEgressTarget('not-a-url', { lookupFn: throwingLookup });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/not a valid absolute URL/);
  });

  it('does not block on DNS failure — fetch surfaces the real network error', async () => {
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const v = await checkEgressTarget('https://nx.example/', { lookupFn: failing });
    expect(v.allowed).toBe(true);
  });
});

describe('checkEgressTarget — DNS-rebinding guard (resolved IP, not the literal)', () => {
  it('blocks a benign-looking hostname that resolves to 127.0.0.1', async () => {
    const lookupFn = fixedLookup('127.0.0.1');
    const v = await checkEgressTarget('https://totally-safe.example.com/', { lookupFn });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain('127.0.0.1');
    expect(v.allowed === false && v.reason).toContain('resolved');
    expect(lookupFn).toHaveBeenCalledWith('totally-safe.example.com');
  });

  it('blocks a hostname that resolves to the cloud metadata IP', async () => {
    const v = await checkEgressTarget('https://metadata.attacker.example/', {
      lookupFn: fixedLookup('169.254.169.254'),
    });
    expect(v.allowed).toBe(false);
  });

  it('blocks when ANY resolved record is internal (mixed public + internal)', async () => {
    const v = await checkEgressTarget('https://mixed.example/', {
      lookupFn: fixedLookup('93.184.216.34', '10.1.2.3'),
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain('10.1.2.3');
  });

  it('blocks a hostname resolving to an internal IPv6 address', async () => {
    const v = await checkEgressTarget('https://v6.example/', { lookupFn: fixedLookup('fd00::1') });
    expect(v.allowed).toBe(false);
  });

  it('blocks decimal/short-form loopback encodings via URL normalization', async () => {
    for (const url of ['http://2130706433/', 'http://127.1/', 'http://0x7f.0.0.1/', 'http://0/']) {
      const v = await checkEgressTarget(url, { lookupFn: throwingLookup });
      expect(v.allowed, url).toBe(false);
    }
  });

  it('blocks `localhost` when it resolves to loopback', async () => {
    const v = await checkEgressTarget('http://localhost:8080/admin', {
      lookupFn: fixedLookup('::1', '127.0.0.1'),
    });
    expect(v.allowed).toBe(false);
  });
});

describe('assertEgressAllowed', () => {
  it('throws EgressBlockedError on a blocked target', async () => {
    await expect(
      assertEgressAllowed('http://169.254.169.254/', { lookupFn: throwingLookup }),
    ).rejects.toThrow(EgressBlockedError);
  });

  it('resolves silently for an allowed target', async () => {
    await expect(
      assertEgressAllowed('https://example.com/', { lookupFn: publicLookup }),
    ).resolves.toBeUndefined();
  });
});

describe('AFK_WEB_ALLOW_PRIVATE_HOSTS opt-out', () => {
  it('is off by default — guard active', async () => {
    expect(privateHostsAllowed()).toBe(false);
    const v = await checkEgressTarget('http://127.0.0.1:3000/', { lookupFn: throwingLookup });
    expect(v.allowed).toBe(false);
  });

  for (const raw of ['1', 'true', 'TRUE', ' 1 ']) {
    it(`allows private hosts when set to ${JSON.stringify(raw)}`, async () => {
      vi.stubEnv('AFK_WEB_ALLOW_PRIVATE_HOSTS', raw);
      expect(privateHostsAllowed()).toBe(true);
      const v = await checkEgressTarget('http://127.0.0.1:3000/', { lookupFn: throwingLookup });
      expect(v.allowed).toBe(true);
    });
  }

  for (const raw of ['0', 'false', '', 'yes']) {
    it(`keeps the guard active for ${JSON.stringify(raw)}`, async () => {
      vi.stubEnv('AFK_WEB_ALLOW_PRIVATE_HOSTS', raw);
      const v = await checkEgressTarget('http://127.0.0.1:3000/', { lookupFn: throwingLookup });
      expect(v.allowed).toBe(false);
    });
  }

  it('opt-out also bypasses the redirect-hop check in guardedFetch', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes('127.0.0.1')
        ? new Response('internal', { status: 200 })
        : new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
    });
    const res = await guardedFetch(fetchFn as unknown as typeof fetch, 'https://public.example/', {}, {
      allowPrivateHosts: true,
      lookupFn: publicLookup,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('internal');
  });
});

describe('guardedFetch — per-redirect-hop re-validation', () => {
  const noRetrySleep = { sleep: async (): Promise<void> => undefined };

  it('blocks a public URL that redirects to the cloud metadata IP', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/iam/' },
      }),
    );
    await expect(
      guardedFetch(fetchFn as unknown as typeof fetch, 'https://public.example/', {}, {
        lookupFn: publicLookup,
        retry: noRetrySleep,
      }),
    ).rejects.toThrow(EgressBlockedError);
    // The first hop was fetched; the blocked hop was never requested.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('https://public.example/');
  });

  it('forces redirect:"manual" so hops cannot be followed opaquely', async () => {
    const fetchFn = vi.fn(async () => new Response('ok', { status: 200 }));
    await guardedFetch(fetchFn as unknown as typeof fetch, 'https://public.example/', {}, {
      lookupFn: publicLookup,
    });
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('blocks a RELATIVE redirect that lands on an internal host', async () => {
    // Hop 1 is a public host; hop 2 resolves (via DNS) to loopback.
    const lookupFn = vi.fn(async (hostname: string) => [
      { address: hostname === 'internal.example' ? '127.0.0.1' : '93.184.216.34' },
    ]);
    const fetchFn = vi.fn(async () =>
      new Response(null, { status: 301, headers: { location: '//internal.example/x' } }),
    );
    await expect(
      guardedFetch(fetchFn as unknown as typeof fetch, 'https://public.example/start', {}, {
        lookupFn,
        retry: noRetrySleep,
      }),
    ).rejects.toThrow(/internal\/private address 127\.0\.0\.1/);
  });

  it('follows a multi-hop chain of public URLs and returns the final response', async () => {
    const chain: Record<string, Response> = {
      'https://a.example/': new Response(null, { status: 302, headers: { location: 'https://b.example/' } }),
      'https://b.example/': new Response(null, { status: 307, headers: { location: '/final' } }),
      'https://b.example/final': new Response('landed', { status: 200 }),
    };
    const seen: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      const res = chain[url];
      if (res === undefined) throw new Error(`unexpected fetch: ${url}`);
      // `res.url` is empty on a constructed Response, so guardedFetch resolves
      // a relative Location against the requested URL — exercised by /final.
      return res;
    });
    const res = await guardedFetch(fetchFn as unknown as typeof fetch, 'https://a.example/', {}, {
      lookupFn: publicLookup,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('landed');
    expect(seen).toEqual(['https://a.example/', 'https://b.example/', 'https://b.example/final']);
  });

  it('returns a redirect response verbatim when Location is missing', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302 }));
    const res = await guardedFetch(fetchFn as unknown as typeof fetch, 'https://public.example/', {}, {
      lookupFn: publicLookup,
    });
    expect(res.status).toBe(302);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('blocks the INITIAL url before issuing any request', async () => {
    const fetchFn = vi.fn(async () => new Response('should not happen', { status: 200 }));
    await expect(
      guardedFetch(fetchFn as unknown as typeof fetch, 'http://169.254.169.254/', {}, {
        lookupFn: throwingLookup,
      }),
    ).rejects.toThrow(EgressBlockedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws rather than looping forever on a redirect cycle', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) =>
      new Response(null, {
        status: 302,
        headers: { location: String(input).endsWith('/b') ? 'https://loop.example/a' : 'https://loop.example/b' },
      }),
    );
    await expect(
      guardedFetch(fetchFn as unknown as typeof fetch, 'https://loop.example/a', {}, {
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/too many redirects/);
  });
});
