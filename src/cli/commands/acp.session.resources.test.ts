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
