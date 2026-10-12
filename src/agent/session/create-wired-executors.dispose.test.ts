import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWiredExecutors } from './create-wired-executors.js';

const { abortAllAndDrain } = vi.hoisted(() => ({ abortAllAndDrain: vi.fn() }));
vi.mock('./wire-executors.js', () => ({
  wireExecutors: () => ({ rootManager: { abortAllAndDrain } }),
}));

afterEach(() => { vi.resetAllMocks(); });

describe('createWiredExecutors dispose rejection caching (#3522)', () => {
  it('shares a failed drain across concurrent and subsequent dispose calls', async () => {
    let reject!: (error: Error) => void;
    abortAllAndDrain.mockReturnValue(new Promise((_, rej) => { reject = rej; }));
    const wired = createWiredExecutors(
      { model: 'claude-haiku-4-5', apiKey: 'test-key' },
      { unattended: true },
    );
    const first = wired.dispose();
    const concurrent = wired.dispose();
    expect(concurrent).toBe(first);
    expect(abortAllAndDrain).toHaveBeenCalledExactlyOnceWith('session_end', 'user_signal', undefined, false);

    const failure = new Error('drain failed');
    const firstRejection = expect(first).rejects.toBe(failure);
    const concurrentRejection = expect(concurrent).rejects.toBe(failure);
    reject(failure);
    await Promise.all([firstRejection, concurrentRejection]);

    const later = wired.dispose();
    expect(later).toBe(first);
    await expect(later).rejects.toBe(failure);
    expect(abortAllAndDrain).toHaveBeenCalledTimes(1);
  });
});
