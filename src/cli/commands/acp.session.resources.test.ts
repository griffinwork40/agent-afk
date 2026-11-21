import { describe, expect, it, vi } from 'vitest';
import { AcpSessionResources, onceAcpShutdown } from './acp.session.resources.js';

describe('ACP resource ownership', () => {
  it('releases in reverse acquisition order, once, despite a failing disposer', async () => {
    const resources = new AcpSessionResources();
    const released: string[] = [];
    resources.add(() => { released.push('trace'); });
    resources.add(() => { released.push('stores'); });
    resources.add(async () => { released.push('mcp'); throw new Error('disconnect failed'); });
    resources.add(() => { released.push('children'); });
    await Promise.all([resources.release(), resources.release()]);
    await resources.release();
    expect(released).toEqual(['children', 'mcp', 'stores', 'trace']);
  });

  it('[C2] release iterates a reversed copy, leaving the registered order intact', async () => {
    const resources = new AcpSessionResources();
    const order: string[] = [];
    resources.add(() => { order.push('a'); });
    resources.add(() => { order.push('b'); });
    resources.add(() => { order.push('c'); });
    // Capture the array reference before release.
    // After release the array must still be in registration order [a, b, c].
    const disposers = (resources as unknown as { disposers: Array<() => unknown> }).disposers;
    const beforeRelease = [...disposers];
    await resources.release();
    // Released in reverse order c, b, a.
    expect(order).toEqual(['c', 'b', 'a']);
    // Registration order unchanged.
    expect(disposers).toEqual(beforeRelease);
  });

  it('D17: a hung owner is abandoned at its deadline and later owners still release', async () => {
    const resources = new AcpSessionResources(30);
    const released: string[] = [];
    resources.add(() => { released.push('trace'); });
    resources.add(() => new Promise(() => { /* an MCP server that never disconnects */ }));
    resources.add(() => { released.push('children'); });
    const started = Date.now();
    await resources.release();
    expect(released).toEqual(['children', 'trace']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('shares the drain receipt between session close and external rollback', async () => {
    const drain = vi.fn(async () => { throw new Error('drain failed'); });
    const once = onceAcpShutdown(drain);
    const first = once('close');
    const second = once('close');
    expect(first).toBe(second);
    await expect(first).rejects.toThrow('drain failed');
    await expect(second).rejects.toThrow('drain failed');
    expect(drain).toHaveBeenCalledOnce();
  });
});
