/**
 * Unit tests for recheckLandedUrl (src/browser/playwright/domain-recheck.ts).
 *
 * Strategy: the helper takes a narrow `RecheckablePage` (url + goBack), so no
 * playwright import and no browser process is needed — a two-method stub is
 * enough. The real `enforceDomainPolicy` from ../config.js is used here (it is
 * a pure function over BrowserConfig), so these tests exercise the actual
 * allow/block glob semantics rather than a mock's idea of them.
 *
 * The SSRF guard (checkEgressTarget) is exercised via two mechanisms:
 *   - Existing domain-policy tests pass `allowPrivateHosts: true` so they skip
 *     DNS and remain fast and deterministic.
 *   - The new #2301 SSRF tests pass an injectable `lookupFn` that returns
 *     controlled addresses, verifying SSRF classification logic directly.
 */

import { describe, it, expect, vi } from 'vitest';
import type { BrowserConfig } from '../types.js';
import { recheckLandedUrl, type RecheckablePage } from './domain-recheck.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    headless: true,
    allowedDomains: [],
    blockedDomains: [],
    domSnapshots: false,
    backend: 'playwright',
    configPath: null,
    defaultProfile: 'default',
    ...overrides,
  };
}

function makePage(landedUrl: string): RecheckablePage & {
  goBack: ReturnType<typeof vi.fn>;
} {
  return {
    url: () => landedUrl,
    goBack: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Convenience wrapper for domain-policy-only tests: bypasses the SSRF guard
 * (`allowPrivateHosts: true`) so tests stay deterministic without real DNS.
 */
function recheck(page: RecheckablePage, config: BrowserConfig, clearedUrl: string) {
  return recheckLandedUrl(page, config, clearedUrl, vi.fn().mockResolvedValue(undefined), {
    allowPrivateHosts: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recheckLandedUrl', () => {
  it('returns null when the tab never left the already-cleared URL', async () => {
    // Denylist would refuse it, but an unmoved tab is not re-checked: the
    // caller already cleared this URL through the same policy.
    const page = makePage('https://example.com/page');
    const config = makeConfig({ blockedDomains: ['example.com'] });

    const result = await recheck(page, config, 'https://example.com/page');

    expect(result).toBeNull();
    expect(page.goBack).not.toHaveBeenCalled();
  });

  it('returns null when the landed URL is a different but allowed host', async () => {
    const page = makePage('https://b.example/landed');
    const config = makeConfig({ allowedDomains: ['a.example', 'b.example'] });

    const result = await recheck(page, config, 'https://a.example/start');

    expect(result).toBeNull();
    expect(page.goBack).not.toHaveBeenCalled();
  });

  it('blocks a landed host that is not in a non-empty allowlist', async () => {
    const page = makePage('https://evil.com/landed');
    const config = makeConfig({ allowedDomains: ['a.example'] });

    const result = await recheck(page, config, 'https://a.example/start');

    expect(result).toEqual({
      outcome: 'blocked_by_policy',
      url: 'https://evil.com/landed',
      reason: 'not in AFK_BROWSER_ALLOWED_DOMAINS',
    });
  });

  it('blocks a landed host on the denylist even when the allowlist is empty', async () => {
    const page = makePage('https://tracker.evil.com/pixel');
    const config = makeConfig({ blockedDomains: ['*.evil.com'] });

    const result = await recheck(page, config, 'https://a.example/start');

    expect(result).toMatchObject({
      outcome: 'blocked_by_policy',
      url: 'https://tracker.evil.com/pixel',
      reason: 'blocked by AFK_BROWSER_BLOCKED_DOMAINS: *.evil.com',
    });
  });

  it('calls goBack() best-effort when the landed URL is refused', async () => {
    const page = makePage('https://evil.com/landed');
    const config = makeConfig({ allowedDomains: ['a.example'] });

    await recheck(page, config, 'https://a.example/start');

    expect(page.goBack).toHaveBeenCalledTimes(1);
  });

  it('invalidates the session and still returns the refusal when goBack() rejects', async () => {
    const page = makePage('https://evil.com/landed');
    page.goBack.mockRejectedValue(new Error('navigation failed'));
    const config = makeConfig({ allowedDomains: ['a.example'] });

    const invalidateSession = vi.fn().mockResolvedValue(undefined);

    // A goBack failure must not mask the policy outcome or leave a readable
    // session parked on the blocked page.
    await expect(
      recheckLandedUrl(page, config, 'https://a.example/start', invalidateSession),
    ).resolves.toMatchObject({ outcome: 'blocked_by_policy' });
    expect(invalidateSession).toHaveBeenCalledTimes(1);
  });

  it('returns null for any landed host when both lists are empty (fail-open)', async () => {
    const page = makePage('https://anything.example/landed');

    const result = await recheck(page, makeConfig(), 'https://a.example/start');

    expect(result).toBeNull();
  });

  it('blocks an unparseable landed URL', async () => {
    const page = makePage('not a url');

    const result = await recheck(page, makeConfig(), 'https://a.example/start');

    expect(result).toMatchObject({
      outcome: 'blocked_by_policy',
      reason: 'invalid URL: not a url',
    });
  });

  // -------------------------------------------------------------------------
  // SSRF guard on landed URL (#2301)
  //
  // A redirect from a public URL to a private IP bypasses the pre-navigation
  // check in open(). recheckLandedUrl now runs checkEgressTarget on the landed
  // URL so that redirect-laundered SSRF is also blocked.
  // -------------------------------------------------------------------------

  it('blocks a private-IP landed URL via the SSRF guard (#2301)', async () => {
    // Simulate: public URL redirected to the IMDS endpoint.
    const page = makePage('http://169.254.169.254/latest/meta-data/');
    // Injectable lookup returns a private IP so we don't need real DNS.
    const lookupFn = vi.fn().mockResolvedValue([{ address: '169.254.169.254' }]);

    const result = await recheckLandedUrl(
      page,
      makeConfig(),
      'https://allowed.example/start',
      vi.fn().mockResolvedValue(undefined),
      { lookupFn },
    );

    expect(result).toMatchObject({
      outcome: 'blocked_by_policy',
      url: 'http://169.254.169.254/latest/meta-data/',
      reason: expect.stringContaining('169.254.169.254'),
    });
    // goBack() attempted as best-effort rollback.
    expect(page.goBack).toHaveBeenCalled();
  });

  it('blocks a loopback-resolved hostname landed URL via the SSRF guard (#2301)', async () => {
    // Simulate: public redirect target resolves to 127.0.0.1.
    const page = makePage('http://internal.example/');
    const lookupFn = vi.fn().mockResolvedValue([{ address: '127.0.0.1' }]);

    const result = await recheckLandedUrl(
      page,
      makeConfig(),
      'https://allowed.example/start',
      vi.fn().mockResolvedValue(undefined),
      { lookupFn },
    );

    expect(result).toMatchObject({
      outcome: 'blocked_by_policy',
      url: 'http://internal.example/',
      reason: expect.stringContaining('127.0.0.1'),
    });
  });

  it('allows a public landed URL when SSRF guard passes (#2301)', async () => {
    const page = makePage('https://cdn.example/page');
    const lookupFn = vi.fn().mockResolvedValue([{ address: '93.184.216.34' }]);

    const result = await recheckLandedUrl(
      page,
      makeConfig(),
      'https://allowed.example/start',
      vi.fn().mockResolvedValue(undefined),
      { lookupFn },
    );

    expect(result).toBeNull();
  });
});
