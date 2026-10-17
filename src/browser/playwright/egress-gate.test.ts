import { describe, it, expect, vi } from 'vitest';
import { checkNavigationEgress, installRenderRouteGuard } from './egress-gate.js';

describe('egress-gate (#3721)', () => {
  it('blocks the IMDS literal before navigation', async () => {
    const out = await checkNavigationEgress('http://169.254.169.254/latest/meta-data/');
    expect(out?.outcome).toBe('blocked_by_policy');
    expect(out?.url).toBe('http://169.254.169.254/latest/meta-data/');
  });

  it('allows a public IP literal', async () => {
    expect(await checkNavigationEgress('https://93.184.216.34/')).toBeNull();
  });

  it('preserves arbitrary caller-supplied render policy, not just SSRF checks', async () => {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = { route: vi.fn(async (_p: string, h: typeof handler) => { handler = h; }) };
    const refusal = new Error('caller disallows this public host');
    const guard = vi.fn().mockRejectedValue(refusal);
    const onRefusal = vi.fn();
    await installRenderRouteGuard(context as never, guard, onRefusal);
    const abort = vi.fn().mockResolvedValue(undefined);
    const proceed = vi.fn();
    await handler!({ request: () => ({ url: () => 'https://93.184.216.34/' }), abort, continue: proceed });
    expect(guard).toHaveBeenCalledWith('https://93.184.216.34/');
    expect(onRefusal).toHaveBeenCalledWith(refusal);
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
    expect(proceed).not.toHaveBeenCalled();
  });
});
