/**
 * Reproducer: interactive mode drops 2nd message.
 * Mirrors the CLI's sendMessageStream loop EXACTLY — no early break.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentConfig, OutputEvent } from './index.js';
import { createMockProvider } from './__fixtures__/mock-provider.js';

vi.mock('../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

import { AgentSession } from './index.js';

describe('Interactive CLI flow reproducer', () => {
  let config: AgentConfig;

  beforeEach(() => {
    config = {
      model: 'sonnet',
      maxTurns: 100,
      apiKey: 'test-key',
      provider: createMockProvider(),
    };
  });

  it(
    'sendMessageStream completes twice (matches CLI: drain without early break)',
    { timeout: 10000 },
    async () => {
      const session = new AgentSession(config);
      await session.waitForInitialization();

      const events1: OutputEvent[] = [];
      let response1 = '';
      for await (const event of session.sendMessageStream('Hello')) {
        events1.push(event);
        if (event.type === 'message') response1 = event.message.content;
      }
      expect(response1).toContain('Echo: Hello');
      expect(events1.some((e) => e.type === 'done')).toBe(true);

      const events2: OutputEvent[] = [];
      let response2 = '';
      for await (const event of session.sendMessageStream('World')) {
        events2.push(event);
        if (event.type === 'message') response2 = event.message.content;
      }
      expect(response2).toContain('Echo: World');
      expect(events2.some((e) => e.type === 'done')).toBe(true);

      await session.close();
    },
  );
});
