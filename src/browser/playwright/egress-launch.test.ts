/**
 * Unit tests for egress-launch helpers (#3720).
 * Verifies that buildLaunchOptions wires the proxy correctly and that
 * GuardedEgress.start returns guarded options (proxy + QUIC flags) when the
 * guard is active — the contract that afk browser login now relies on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../http-client/egress-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../http-client/egress-guard.js')>();
  return { ...actual, privateHostsAllowed: vi.fn(() => false) };
});

import { buildLaunchOptions, EGRESS_LAUNCH_ARGS, EGRESS_PROXY_BYPASS, GuardedEgress } from './egress-launch.js';
import { privateHostsAllowed } from '../../http-client/egress-guard.js';

describe('buildLaunchOptions (#3720)', () => {
  it('returns only headless when proxyPort is undefined (opt-out path)', () => {
    expect(buildLaunchOptions(false, undefined)).toEqual({ headless: false });
    expect(buildLaunchOptions(true, undefined)).toEqual({ headless: true });
  });

  it('wires proxy server, bypass, and QUIC-closing args when proxyPort is set', () => {
    const opts = buildLaunchOptions(false, 9999);
    expect(opts.headless).toBe(false);
    expect(opts.proxy?.server).toBe('http://127.0.0.1:9999');
    expect(opts.proxy?.bypass).toBe(EGRESS_PROXY_BYPASS);
    expect(opts.args).toEqual(expect.arrayContaining([...EGRESS_LAUNCH_ARGS]));
  });
});

describe('GuardedEgress.start — login launch contract (#3720)', () => {
  let listenMock: ReturnType<typeof vi.fn>;
  let closeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listenMock = vi.fn().mockResolvedValue(12345);
    closeMock = vi.fn().mockResolvedValue(undefined);
  });

  it('returns guarded launch options (proxy + args) when guard is active', async () => {
    vi.mocked(privateHostsAllowed).mockReturnValue(false);
    const egress = new GuardedEgress({ listen: listenMock, close: closeMock } as never);
    const opts = await egress.start(false);
    expect(opts.headless).toBe(false);
    expect(opts.proxy?.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(opts.args).toEqual(expect.arrayContaining([...EGRESS_LAUNCH_ARGS]));
    expect(egress.isActive()).toBe(true);
    await egress.stop();
  });

  it('returns unguarded options when AFK_WEB_ALLOW_PRIVATE_HOSTS is set', async () => {
    vi.mocked(privateHostsAllowed).mockReturnValue(true);
    const egress = new GuardedEgress();
    const opts = await egress.start(false);
    expect(opts.proxy).toBeUndefined();
    expect(opts.args).toBeUndefined();
    expect(egress.isActive()).toBe(false);
    vi.mocked(privateHostsAllowed).mockReturnValue(false);
  });
});
