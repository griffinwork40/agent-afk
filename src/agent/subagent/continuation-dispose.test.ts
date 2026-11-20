import { describe, expect, it, vi } from 'vitest';
import { drainThenDispose, withContinuationDispose } from './continuation-dispose.js';

describe('drainThenDispose (#4266)', () => {
  it('disposes after a resolved drain and returns its result', async () => {
    const registry = { dispose: vi.fn(), getPendingReleaseWrites: vi.fn().mockReturnValue([]) };
    await expect(drainThenDispose(async () => 7, registry)).resolves.toBe(7);
    expect(registry.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes when the drain rejects and propagates the rejection', async () => {
    const registry = { dispose: vi.fn(), getPendingReleaseWrites: vi.fn().mockReturnValue([]) };
    const failure = new Error('drain failed');
    await expect(drainThenDispose(async () => { throw failure; }, registry)).rejects.toBe(failure);
    expect(registry.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose until the drain has settled', async () => {
    const registry = { dispose: vi.fn(), getPendingReleaseWrites: vi.fn().mockReturnValue([]) };
    let release!: () => void;
    const pending = drainThenDispose(() => new Promise<void>((r) => { release = r; }), registry);
    await Promise.resolve();
    expect(registry.dispose).not.toHaveBeenCalled();
    release();
    await pending;
    expect(registry.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('withContinuationDispose (#4266)', () => {
  it('disposes when the wrapped drainSubagents rejects', async () => {
    const registry = { dispose: vi.fn(), getPendingReleaseWrites: vi.fn().mockReturnValue([]) };
    const failure = new Error('drain failed');
    const shutdown = { drainSubagents: vi.fn(async (_reason: string) => { throw failure; }), other: 1 };
    const wrapped = withContinuationDispose(shutdown, registry);
    expect(wrapped.other).toBe(1);
    await expect(wrapped.drainSubagents('close')).rejects.toBe(failure);
    expect(shutdown.drainSubagents).toHaveBeenCalledWith('close');
    expect(registry.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes when the shutdown config has no drainSubagents', async () => {
    const registry = { dispose: vi.fn(), getPendingReleaseWrites: vi.fn().mockReturnValue([]) };
    await expect(withContinuationDispose({}, registry).drainSubagents('close')).resolves.toBeUndefined();
    expect(registry.dispose).toHaveBeenCalledTimes(1);
  });
});
