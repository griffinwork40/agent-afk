import { afterEach, describe, expect, it, vi } from 'vitest';
import { LspServerPool } from './pool.js';
import type { LspClient } from './client.js';
import { TYPESCRIPT_SERVER_DEFINITION } from './typescript-default.js';

const spec = { definition: TYPESCRIPT_SERVER_DEFINITION, command: 'unused', args: [], source: 'override' as const };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('pool idle touch-and-recheck', () => {
  it('warm acquires allocate no timers and eviction waits only the remaining idle window', async () => {
    vi.useFakeTimers();
    const client = { alive: true, lastActivityAt: Date.now(), pendingRequests: 0,
      onExit: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) };
    const pool = new LspServerPool({ idleShutdownMs: 100, startClient: async () => client as unknown as LspClient });
    await pool.acquire(spec, '/workspace');
    await vi.advanceTimersByTimeAsync(60);
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    for (let i = 0; i < 100; i++) await pool.acquire(spec, '/workspace');
    expect(schedule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    expect(client.dispose).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 60);
    await vi.advanceTimersByTimeAsync(59);
    expect(pool.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pool.size).toBe(0);
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('keeps pending requests alive and observes subsequent client activity', async () => {
    vi.useFakeTimers();
    const client = { alive: true, lastActivityAt: Date.now(), pendingRequests: 1,
      onExit: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) };
    const pool = new LspServerPool({ idleShutdownMs: 100, startClient: async () => client as unknown as LspClient });
    await pool.acquire(spec, '/workspace');
    await vi.advanceTimersByTimeAsync(150);
    expect(client.dispose).not.toHaveBeenCalled();
    client.pendingRequests = 0;
    client.lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(99);
    expect(client.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.dispose).toHaveBeenCalledOnce();
  });
});
