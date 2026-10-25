import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandWatchdog } from './routes.commands.watchdog.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function settled(p: Promise<unknown>): Promise<'pending' | 'rejected'> {
  let state: 'pending' | 'rejected' = 'pending';
  p.catch(() => { state = 'rejected'; });
  await vi.advanceTimersByTimeAsync(0);
  return state;
}

describe('createCommandWatchdog', () => {
  it('times out a command that shows no sign of life', async () => {
    const w = createCommandWatchdog(15_000);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await settled(w.promise)).toBe('rejected');
    await expect(w.promise).rejects.toThrow('command_timeout');
  });

  it('never times out while a picker is pending, however long the operator takes', async () => {
    const w = createCommandWatchdog(15_000);
    let answer!: (v: string) => void;
    const choice = w.hold(new Promise<string>((r) => { answer = r; }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await settled(w.promise)).toBe('pending');
    answer('sonnet');
    await expect(choice).resolves.toBe('sonnet');
    // The idle clock restarts once the choice settles.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await settled(w.promise)).toBe('rejected');
  });

  it('never times out inside an open progress span (long /compact), resumes after end', async () => {
    const w = createCommandWatchdog(15_000);
    w.progress({ corrId: 'compact', phase: 'start' });
    await vi.advanceTimersByTimeAsync(90_000);
    w.progress({ corrId: 'compact', phase: 'update' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await settled(w.promise)).toBe('pending');
    w.progress({ corrId: 'compact', phase: 'end' });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await settled(w.promise)).toBe('rejected');
  });

  it('does not reject after dispose', async () => {
    const w = createCommandWatchdog(15_000);
    w.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled(w.promise)).toBe('pending');
  });
});
