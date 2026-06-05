/**
 * Subagent multi-turn test: does session.sendMessage work twice on a subagent?
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentConfig } from './index.js';
import { SubagentManager } from './index.js';
import { createMockProvider } from './__fixtures__/mock-provider.js';

vi.mock('../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

import { AgentSession } from './index.js';

describe('Subagent multi-turn with mock provider', () => {
  let parentConfig: AgentConfig;

  beforeEach(() => {
    parentConfig = { model: 'sonnet', maxTurns: 100, apiKey: 'test-key', provider: createMockProvider() };
  });

  it(
    'subagent session.sendMessage() should work on 2nd call',
    { timeout: 15000 },
    async () => {
      const parent = new AgentSession(parentConfig);
      await parent.waitForInitialization();

      const manager = new SubagentManager();
      const subagent = await manager.forkSubagent({
        parent,
        config: { ...parentConfig },
      });

      const result1 = await subagent.run('first message');
      expect(result1.content).toContain('Echo: first message');

      const result2 = await subagent.run('second message');
      expect(result2.content).toContain('Echo: second message');

      await manager.killAll();
      await parent.close();
    },
  );
});
