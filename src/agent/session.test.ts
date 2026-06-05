/**
 * Tests for AgentSession using a mock ModelProvider.
 *
 * Injects a fake ModelProvider that yields ProviderEvents directly,
 * bypassing any real SDK. Covers session lifecycle, sendMessage,
 * multi-turn history, interrupt, close, reset.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentConfig } from './types.js';
import { createMockProvider, type MockProviderHandle } from './__fixtures__/mock-provider.js';

vi.mock('../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

// Import after mocks are set up
import { AgentSession } from './session.js';

describe('AgentSession', () => {
  let config: AgentConfig;
  let mockProvider: MockProviderHandle;

  beforeEach(() => {
    mockProvider = createMockProvider();
    config = {
      model: 'sonnet',
      maxTurns: 10,
      apiKey: 'test-key',
      provider: mockProvider,
    };
  });

  describe('constructor', () => {
    it('should create a session with valid config', () => {
      const session = new AgentSession(config);
      expect(session.state).toBe('idle');
      expect(session.getTurnCount()).toBe(0);
    });
  });

  describe('session metadata', () => {
    it('should expose session identity after initialization', async () => {
      const session = new AgentSession(config);
      const metadata = await session.waitForInitialization();

      expect(session.sessionId).toBe('mock-session-123');
      expect(metadata).toMatchObject({
        sessionId: 'mock-session-123',
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        cwd: '/tmp/mock-cwd',
      });
      await session.close();
    });

    it('should expose native query capability helpers', async () => {
      const session = new AgentSession(config);
      await session.waitForInitialization();

      await expect(session.supportedModels()).resolves.toEqual([
        { value: 'claude-sonnet-4-6', displayName: 'Mock', description: 'Mock model' },
      ]);
      await expect(session.accountInfo()).resolves.toEqual({
        subscriptionType: 'api-key',
      });
      await session.close();
    });
  });

  describe('runtime controls', () => {
    it('interrupt() leaves the session reusable for subsequent sendMessage', async () => {
      const session = new AgentSession(config);
      const first = await session.sendMessage('first');
      expect(first.content).toContain('Echo: first');

      await session.interrupt();
      expect(session.state).toBe('idle');

      const second = await session.sendMessage('second');
      expect(second.content).toContain('Echo: second');
      await session.close();
    });

    it('interrupt() is a no-op when session is idle', async () => {
      const session = new AgentSession(config);
      await session.waitForInitialization();

      await session.interrupt();
      expect(session.state).toBe('idle');
      expect(mockProvider.queries[0]!.interruptCalls).toBe(0);
      await session.close();
    });

    it('interrupt() is a no-op when session is closed', async () => {
      const session = new AgentSession(config);
      await session.close();

      await session.interrupt();
      expect(session.state).toBe('closed');
    });
  });

  describe('sendMessage - batch mode', () => {
    it('should send and receive message', async () => {
      const session = new AgentSession(config);
      const response = await session.sendMessage('Hello');

      expect(response.role).toBe('assistant');
      expect(response.content).toContain('Echo: Hello');
      expect(session.getTurnCount()).toBe(1);
      await session.close();
    });

    it('should attach result metadata to the returned message', async () => {
      const session = new AgentSession(config);
      const response = await session.sendMessage('Hello metadata');

      expect(response.metadata?.resultSubtype).toBe('success');
      expect(response.metadata?.stopReason).toBe('end_turn');
      expect(response.metadata?.durationMs).toBe(12);
      await session.close();
    });

    it('should reject concurrent sends while the session is busy', async () => {
      const session = new AgentSession(config);
      const first = session.sendMessage('slow response');

      await expect(session.sendMessage('concurrent request')).rejects.toThrow(
        'Cannot send message: session is busy',
      );

      await first;
      await session.close();
    });

    it('should track conversation history', async () => {
      const session = new AgentSession(config);

      await session.sendMessage('First message');
      await session.sendMessage('Second message');

      const history = session.getHistory();
      expect(history).toHaveLength(4);
      expect(history[0]!.role).toBe('user');
      expect(history[1]!.role).toBe('assistant');
      expect(history[2]!.role).toBe('user');
      expect(history[3]!.role).toBe('assistant');
      await session.close();
    });

    it('should respect max turns limit', async () => {
      const session = new AgentSession({ ...config, maxTurns: 2 });

      await session.sendMessage('Turn 1');
      await session.sendMessage('Turn 2');

      await expect(session.sendMessage('Turn 3')).rejects.toThrow('Maximum turns (2) exceeded');
      await session.close();
    });

    it('should throw when sending to closed session', async () => {
      const session = new AgentSession(config);
      await session.close();

      await expect(session.sendMessage('Test')).rejects.toThrow(
        'Cannot send message: session is closed',
      );
    });
  });

  describe('close', () => {
    it('should close session and mark as closed', async () => {
      const session = new AgentSession(config);
      expect(session.state).toBe('idle');

      await session.close();
      expect(session.state).toBe('closed');
    });

    it('should be idempotent', async () => {
      const session = new AgentSession(config);

      await session.close();
      await session.close();

      expect(session.state).toBe('closed');
    });
  });

  describe('getHistory', () => {
    it('should return immutable history', async () => {
      const session = new AgentSession(config);

      await session.sendMessage('Test');
      const history1 = session.getHistory();
      const history2 = session.getHistory();

      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
      await session.close();
    });
  });

  describe('getTurnCount', () => {
    it('should track turn count correctly', async () => {
      const session = new AgentSession(config);

      expect(session.getTurnCount()).toBe(0);

      await session.sendMessage('Turn 1');
      expect(session.getTurnCount()).toBe(1);

      await session.sendMessage('Turn 2');
      expect(session.getTurnCount()).toBe(2);
      await session.close();
    });
  });

  describe('reset', () => {
    it('rebuilds the provider query, clears history, and resets turn count', async () => {
      const session = new AgentSession(config);

      await session.sendMessage('Turn 1');
      await session.sendMessage('Turn 2');
      expect(session.getTurnCount()).toBe(2);
      expect(session.getHistory().length).toBe(4);
      expect(mockProvider.queries).toHaveLength(1);

      await session.reset();

      expect(mockProvider.queries[0]!.closeCalls).toBeGreaterThan(0);
      expect(mockProvider.queries).toHaveLength(2);
      expect(session.getTurnCount()).toBe(0);
      expect(session.getHistory().length).toBe(0);
      expect(session.state).toBe('idle');

      const reply = await session.sendMessage('Fresh turn');
      expect(reply.role).toBe('assistant');
      expect(session.getTurnCount()).toBe(1);
      await session.close();
    });

    it('throws if the session is closed', async () => {
      const session = new AgentSession(config);
      await session.close();

      await expect(session.reset()).rejects.toThrow(/closed/);
    });

    it('is safe to call repeatedly', async () => {
      const session = new AgentSession(config);

      await session.reset();
      await session.reset();
      await session.reset();

      expect(mockProvider.queries).toHaveLength(4); // initial + 3 resets
      expect(session.state).toBe('idle');

      const reply = await session.sendMessage('Still works?');
      expect(reply.role).toBe('assistant');
      await session.close();
    });

    it('throws AbortError when an external abortSignal fired before reset', async () => {
      const externalController = new AbortController();
      const session = new AgentSession({
        ...config,
        abortSignal: externalController.signal,
      });

      externalController.abort('test-abort');

      await expect(session.reset()).rejects.toThrow(/aborted/);
    });
  });
});
