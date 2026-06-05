/**
 * Integration tests for the agent module using a mock ModelProvider.
 *
 * Drives the real AgentSession against a fake provider that echoes user
 * input as assistant text. Asserts end-to-end multi-turn behaviour,
 * streaming, turn limits, and lifecycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentConfig } from './index.js';
import { createMockProvider } from './__fixtures__/mock-provider.js';

vi.mock('../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

import { AgentSession } from './index.js';

describe('Agent module integration', () => {
  let config: AgentConfig;

  beforeEach(() => {
    config = {
      model: 'sonnet',
      maxTurns: 5,
      apiKey: 'test-key',
      provider: createMockProvider(),
    };
  });

  describe('full conversation flow', () => {
    it(
      'should handle multi-turn conversation',
      { timeout: 15000 },
      async () => {
        const session = new AgentSession(config);
        await session.waitForInitialization();

        const response1 = await session.sendMessage('Hello');
        expect(response1.content).toContain('Echo: Hello');

        const response2 = await session.sendMessage('How are you?');
        expect(response2.content).toContain('Echo: How are you?');

        expect(session.getTurnCount()).toBe(2);
        expect(session.getHistory()).toHaveLength(4);

        await session.close();
        expect(session.state).toBe('closed');
      },
    );
  });

  describe('streaming multi-turn conversation', () => {
    it(
      'should handle multi-turn streaming with early break on done',
      { timeout: 15000 },
      async () => {
        const session = new AgentSession(config);
        await session.waitForInitialization();

        const events1: unknown[] = [];
        const stream1 = session.sendMessageStream('Hello');
        for await (const event of stream1) {
          events1.push(event);
          if ((event as { type: string }).type === 'done') break;
        }
        expect(events1.some((e: unknown) => (e as { type: string }).type === 'done')).toBe(true);
        expect(
          events1.some(
            (e: unknown) =>
              (e as { type: string }).type === 'message' &&
              ((e as { message?: { content?: string } }).message?.content ?? '').includes('Echo: Hello'),
          ),
        ).toBe(true);
        expect(session.getTurnCount()).toBe(1);

        const events2: unknown[] = [];
        const stream2 = session.sendMessageStream('Second');
        for await (const event of stream2) {
          events2.push(event);
          if ((event as { type: string }).type === 'done') break;
        }
        expect(events2.some((e: unknown) => (e as { type: string }).type === 'done')).toBe(true);
        expect(session.getTurnCount()).toBe(2);
        await session.close();
      },
    );
  });

  describe('turn limit enforcement', () => {
    it('should enforce max turns', async () => {
      const session = new AgentSession({ ...config, maxTurns: 2 });
      await session.waitForInitialization();

      await session.sendMessage('Turn 1');
      await session.sendMessage('Turn 2');

      await expect(session.sendMessage('Turn 3')).rejects.toThrow('Maximum turns (2) exceeded');

      expect(session.getTurnCount()).toBe(2);
      await session.close();
    });
  });

  describe('session lifecycle', () => {
    it(
      'should handle complete lifecycle',
      { timeout: 15000 },
      async () => {
        const session = new AgentSession(config);
        await session.waitForInitialization();
        expect(session.state).toBe('idle');

        await session.sendMessage('Test');
        expect(session.state).not.toBe('closed');

        await session.close();
        expect(session.state).toBe('closed');

        await expect(session.sendMessage('After close')).rejects.toThrow('session is closed');
      },
    );
  });
});
