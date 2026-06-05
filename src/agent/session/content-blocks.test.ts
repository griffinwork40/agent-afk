/**
 * Tests for content block (image/multi-block) support in session transport.
 *
 * Validates that sendMessageStream and the input iterable can accept
 * ContentBlockParam[] in addition to plain strings, while keeping the
 * internal conversation history as a string summary.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AgentConfig } from '../types.js';
import type { ProviderUserTurn } from '../provider.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';

vi.mock('../../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

let capturedTurns: ProviderUserTurn[] = [];

import { AgentSession } from '../session.js';

describe('AgentSession content blocks', () => {
  let config: AgentConfig;

  beforeEach(() => {
    capturedTurns = [];
    config = {
      model: 'sonnet',
      maxTurns: 10,
      apiKey: 'test-key',
      provider: createMockProvider({ onTurn: (turn) => capturedTurns.push(turn) }),
    };
  });

  describe('sendMessageStream with string content', () => {
    it('should send plain string unchanged (backward compatibility)', async () => {
      const session = new AgentSession(config);

      const events: unknown[] = [];
      for await (const _event of session.sendMessageStream('hello')) {
        events.push(_event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(capturedTurns).toHaveLength(1);
      expect(capturedTurns[0]!.content).toBe('hello');

      await session.close();
    });

    it('should store string in conversation history', async () => {
      const session = new AgentSession(config);

      for await (const _event of session.sendMessageStream('test message')) {
        // consume all events
      }

      const history = session.getHistory();
      expect(history).toContainEqual(
        expect.objectContaining({
          role: 'user',
          content: 'test message',
        }),
      );
      await session.close();
    });
  });

  describe('sendMessageStream with ContentBlockParam[]', () => {
    it('should accept and forward ContentBlockParam[] to the provider', async () => {
      const session = new AgentSession(config);

      const contentBlocks: ContentBlockParam[] = [
        { type: 'text', text: 'hello' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          },
        },
      ];

      const events: unknown[] = [];
      for await (const _event of session.sendMessageStream(contentBlocks)) {
        events.push(_event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(capturedTurns).toHaveLength(1);
      expect(capturedTurns[0]!.content).toEqual(contentBlocks);

      await session.close();
    });

    it('should store a string summary in conversation history (not the array)', async () => {
      const session = new AgentSession(config);

      const contentBlocks: ContentBlockParam[] = [
        { type: 'text', text: 'hello' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc',
          },
        },
      ];

      for await (const _event of session.sendMessageStream(contentBlocks)) {
        // consume all events
      }

      const history = session.getHistory();
      const userMsg = history.find((m) => m.role === 'user');

      expect(userMsg).toBeDefined();
      expect(userMsg?.content).toEqual(expect.any(String));
      expect(userMsg?.content.length).toBeGreaterThan(0);

      await session.close();
    });
  });
});
