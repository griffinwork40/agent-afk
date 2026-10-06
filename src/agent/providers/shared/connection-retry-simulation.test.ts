import { afterEach, expect, it, vi } from 'vitest';
import { createWithRetry } from '../anthropic-direct/loop/connection-create.js';
import type { AnthropicMessagesCreateParams } from '../anthropic-direct/types.js';
import { runConnectionPhase } from '../openai-compatible/query/stream-drive.connection.js';

class APIConnectionTimeoutError extends Error {}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('simulates outage durations with real provider policy and bounded 10s connection attempts', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const rows = [];
  for (const provider of ['anthropic', 'openai']) {
    for (const policy of ['legacy', '120s']) {
      for (const outageS of [5, 20, 34, 41, 60, 90, 150, 434]) {
        vi.setSystemTime(0); vi.stubEnv('AFK_CONNECT_RETRY_BUDGET_MS', policy === '120s' ? '120000' : undefined);
        let attempts = 0;
        const create = async () => {
          attempts++;
          // A connection started during the outage times out after 10s, even if
          // connectivity returns meanwhile. Success is immediate on the next opener.
          if (Date.now() < outageS * 1000) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            throw new APIConnectionTimeoutError();
          }
          return { async *[Symbol.asyncIterator]() {} };
        };
        const signal = new AbortController().signal;
        const pending = provider === 'anthropic'
          ? createWithRetry({ messages: { create } }, {} as AnthropicMessagesCreateParams, {}, signal, signal).then(() => true, () => false)
          : runConnectionPhase(create, signal, signal, undefined, 'test').then(result => result.ok);
        await vi.runAllTimersAsync(); const completed = await pending;
        rows.push({ provider, policy, outageS, completed, ticketS: Date.now() / 1000, attempts });
        expect(completed).toBe(policy === '120s' ? outageS <= 90 : outageS <= (provider === 'anthropic' ? 20 : 41));
      }
    }
  }
  console.log('CONNECTION_SIMULATION ' + JSON.stringify(rows));
});
