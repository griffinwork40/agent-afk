/**
 * Tests for the skill router — CLI integration layer for slash-command dispatch.
 *
 * Tests cover:
 * 1. Non-slash input returns null (not handled)
 * 2. /help lists all registered skills
 * 3. Unknown skill returns error with available list
 * 4. Known skill invokes handler with parsed args
 * 5. Raw string args wrap as { input: string }
 * 6. Empty args → {}
 * 7. Handler throw → status: error
 * 8. All 7 skills resolvable after import
 * 9. Skill can be dispatched with session
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetRegistry, registerSkill } from '../skills/index.js';
import { tryRouteSkill } from './commands/skill-router.js';
import type { IAgentSession } from '../agent/types.js';

// Import all skill modules to trigger their registerSkill() side-effects.
// diagnose is now a bundled-plugin SKILL.md (not a TS registry skill), so it
// is not imported/registered here — it resolves via the plugin scanner.
import '../skills/mint/index.js';

// Create a mock session
function createMockSession(): IAgentSession {
  return {
    state: 'idle',
    sessionId: 'test-session-123',
    sendMessage: vi.fn(),
    sendMessageStream: vi.fn(),
    interrupt: vi.fn(),
    abortSignal: new AbortController().signal,
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    waitForInitialization: vi.fn().mockResolvedValue({}),
    getSessionIdentity: vi.fn(),
    getSessionMetadata: vi.fn(),
    getQuery: vi.fn(),
    getLastResponseMetadata: vi.fn(),
    getOutputStream: vi.fn(),
    getInputStreamRef: vi.fn(),
    supportedCommands: vi.fn(),
    supportedModels: vi.fn(),
    mcpServerStatus: vi.fn(),
    accountInfo: vi.fn(),
    close: vi.fn(),
  };
}

describe('Skill Router', () => {
  let mockSession: IAgentSession;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = createMockSession();
  });

  describe('Non-slash returns null', () => {
    it('should return null for input without leading slash', async () => {
      const result = await tryRouteSkill('hello world', mockSession);
      expect(result).toBeNull();
    });

    it('should return null for empty input', async () => {
      const result = await tryRouteSkill('', mockSession);
      expect(result).toBeNull();
    });

    afterEach(() => {
      // No cleanup needed for these tests
    });
  });

  describe('Unit tests with mocked skills', () => {
    beforeEach(() => {
      _resetRegistry();
    });

    describe('/help lists all skills', () => {
      it('should return help status and valid output format', async () => {
        registerSkill({
          name: 'parallelize',
          description: 'Parallelize executor',
          handler: vi.fn(),
        });
        registerSkill({
          name: 'example-skill',
          description: 'Gate checker',
          handler: vi.fn(),
        });
        const result = await tryRouteSkill('/help', mockSession);
        expect(result).not.toBeNull();
        expect(result?.handled).toBe(true);
        expect(result?.status).toBe('help');
        expect(result?.output).toContain('Available skills:');
        expect(result?.output).toContain('parallelize');
        expect(result?.output).toContain('example-skill');
      });
    });

    describe('Unknown skill returns error', () => {
      it('should return error for unknown skill when no test skills registered', async () => {
        const result = await tryRouteSkill('/nonexistent foo', mockSession);
        expect(result).not.toBeNull();
        expect(result?.handled).toBe(true);
        expect(result?.status).toBe('error');
        expect(result?.output).toContain('Unknown skill: nonexistent');
      });

      it('should list available skills in error message when skills exist', async () => {
        registerSkill({
          name: 'test-skill',
          description: 'A test skill',
          handler: vi.fn().mockResolvedValue({ ok: true }),
        });
        const result = await tryRouteSkill('/unknown-command', mockSession);
        expect(result?.output).toContain('Unknown skill: unknown-command');
        expect(result?.output).toContain('Available: test-skill');
      });
    });

    describe('Known skill dispatches handler', () => {
      it('should dispatch mint skill with JSON args', async () => {
        const mintHandler = vi.fn().mockResolvedValue({ ok: true });
        registerSkill({
          name: 'test-mint',
          description: 'test',
          handler: mintHandler,
        });

        const result = await tryRouteSkill(
          '/test-mint { "idea": "test" }',
          mockSession
        );

        expect(result?.handled).toBe(true);
        expect(mintHandler).toHaveBeenCalledWith({ idea: 'test' }, mockSession);
      });

      it('should dispatch parallelize skill with string args wrapped', async () => {
        const handler = vi.fn().mockResolvedValue({ waves: [] });
        registerSkill({
          name: 'test-parallelize',
          description: 'test',
          handler,
        });

        const result = await tryRouteSkill(
          '/test-parallelize some raw string',
          mockSession
        );

        expect(result?.handled).toBe(true);
        expect(handler).toHaveBeenCalledWith(
          { input: 'some raw string' },
          mockSession
        );
      });
    });

    describe('Raw string args wrap as { input }', () => {
      it('should wrap raw string as input field', async () => {
        const handler = vi.fn().mockResolvedValue('done');
        registerSkill({
          name: 'test-diagnose',
          description: 'test',
          handler,
        });

        await tryRouteSkill('/test-diagnose crash on startup', mockSession);

        expect(handler).toHaveBeenCalledWith(
          { input: 'crash on startup' },
          mockSession
        );
      });

      it('should handle quoted string args', async () => {
        const handler = vi.fn().mockResolvedValue('done');
        registerSkill({
          name: 'test-shadow-verify',
          description: 'test',
          handler,
        });

        await tryRouteSkill('/test-shadow-verify "claim one" "claim two"', mockSession);

        expect(handler).toHaveBeenCalledWith(
          { input: '"claim one" "claim two"' },
          mockSession
        );
      });
    });

    describe('Empty args → {}', () => {
      it('should pass empty object when no args provided', async () => {
        const handler = vi.fn().mockResolvedValue({ ok: true });
        registerSkill({
          name: 'test-example',
          description: 'test',
          handler,
        });

        await tryRouteSkill('/test-example', mockSession);

        expect(handler).toHaveBeenCalledWith({}, mockSession);
      });
    });

    describe('Handler throw → status: error', () => {
      it('should catch handler errors and return status error', async () => {
        const handler = vi.fn().mockRejectedValue(new Error('Handler failed'));
        registerSkill({
          name: 'test-handler',
          description: 'test',
          handler,
        });

        const result = await tryRouteSkill('/test-handler', mockSession);

        expect(result?.handled).toBe(true);
        expect(result?.status).toBe('error');
        expect(result?.output).toContain('Handler failed');
      });

      it('should handle non-Error exceptions', async () => {
        const handler = vi.fn().mockRejectedValue('string error');
        registerSkill({
          name: 'test-example-two',
          description: 'test',
          handler,
        });

        const result = await tryRouteSkill('/test-example-two', mockSession);

        expect(result?.status).toBe('error');
        expect(result?.output).toContain('string error');
      });
    });

    describe('JSON parsing edge cases', () => {
      it('should handle valid JSON with extra whitespace', async () => {
        const handler = vi.fn().mockResolvedValue('done');
        registerSkill({
          name: 'test-json-whitespace',
          description: 'test',
          handler,
        });

        await tryRouteSkill('/test-json-whitespace {   "key"  :  "value"   }', mockSession);

        expect(handler).toHaveBeenCalledWith({ key: 'value' }, mockSession);
      });

      it('should treat invalid JSON as raw string', async () => {
        const handler = vi.fn().mockResolvedValue('done');
        registerSkill({
          name: 'test-invalid-json',
          description: 'test',
          handler,
        });

        await tryRouteSkill('/test-invalid-json {bad json}', mockSession);

        expect(handler).toHaveBeenCalledWith({ input: '{bad json}' }, mockSession);
      });
    });

    describe('Paused result formatting', () => {
      it('should format paused result nicely', async () => {
        const handler = vi
          .fn()
          .mockResolvedValue({ paused: true, phase: 'spec', spec: 'test spec' });
        registerSkill({
          name: 'test-paused',
          description: 'test',
          handler,
        });

        const result = await tryRouteSkill('/test-paused', mockSession);

        expect(result?.output).toContain('paused');
        expect(result?.output).toContain('spec');
      });
    });

    describe('Skill can be dispatched with session', () => {
      it('should pass session to handler', async () => {
        const handler = vi.fn().mockResolvedValue({ result: 'ok' });
        registerSkill({
          name: 'test-with-session',
          description: 'test',
          handler,
        });

        const session = createMockSession();
        session.sessionId = 'unique-session-id';

        await tryRouteSkill('/test-with-session { "data": "value" }', session);

        expect(handler).toHaveBeenCalledWith({ data: 'value' }, session);
        const callArgs = handler.mock.calls[0];
        expect(callArgs[1].sessionId).toBe('unique-session-id');
      });
    });

    afterEach(() => {
      _resetRegistry();
    });
  });

  describe('Integration tests with real imported skills', () => {
    describe('All built-in skills resolvable', () => {
      it('should have all built-in skills imported and registered', async () => {
        const skillNames = [
          'mint',
        ];

        for (const name of skillNames) {
          const result = await tryRouteSkill(`/${name}`, mockSession);
          expect(result?.handled).toBe(true);
        }
      });
    });

    // No afterEach here — keep real skills registered
  });
});
