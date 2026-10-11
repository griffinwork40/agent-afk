import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../subagent.js';
import { createWiredExecutors } from './create-wired-executors.js';

describe('createWiredExecutors dispose rejection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caches a rejected close drain across later dispose calls', async () => {
    const failure = new Error('close drain failed');
    const drain = vi
      .spyOn(SubagentManager.prototype, 'abortAllAndDrain')
      .mockRejectedValue(failure);
    const wired = createWiredExecutors(
      { model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test' },
      { unattended: true, agent: true },
    );

    const first = wired.dispose();
    const second = wired.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(wired.dispose()).rejects.toBe(failure);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledWith('session_end', 'user_signal', undefined, false);
  });
});
