import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, privateHostsAllowed: vi.fn(() => false) };
});

import { checkNavigationEgress, egressBlockOutcome, RequestGuardTrap } from './egress-gate.js';
import { EgressBlockedError } from '../../http-client/egress-guard.js';

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
});
