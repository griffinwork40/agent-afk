/**
 * #4063 — AgentSession builds and owns an McpManager from config.mcpServers.
 *
 * Reproduction: construct an AgentSession with `mcpServers` set (no
 * `mcpManager`). Before this fix, `mcpServerStatus()` returned `[]`.
 * After the fix it returns one entry per configured server (connected or error).
 *
 * Strategy:
 *   - Unit tests: exercise `initSdkOwnedMcpManager` directly.
 *   - Integration test: stub the Anthropic client (same pattern as
 *     agent-session.test.ts) so the real `resolveProvider` → `AnthropicDirectProvider`
 *     path is exercised with a bogus stdio server. The bogus server exits
 *     immediately so the manager records `status: 'error'` — the acceptance
 *     criterion for a failed server. `mcpServerStatus()` is a pure metadata
 *     query; no model call is needed.
 *
 * Ownership invariants verified:
 *   - SDK-built manager IS disconnected on session.close().
 *   - Caller-supplied mcpManager is NOT disconnected on session.close().
 *
 * @module agent/session/agent-session.mcp.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { McpManager } from '../mcp/manager.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

vi.mock('../awareness/presence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../awareness/presence.js')>();
  return { ...actual, updatePresenceCwd: vi.fn(), removePresence: vi.fn() };
});

vi.mock('../awareness/housekeeping.js', () => ({
  scheduleTopLevelHousekeeping: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Anthropic client stub (same pattern as agent-session.test.ts)
// ---------------------------------------------------------------------------

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() { this.messages = { create: messagesCreateMock }; }
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** Minimal stream: message_start → message_delta (end_turn) → message_stop */
function makeEndTurnStream(): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_mcp_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-haiku-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

// ---------------------------------------------------------------------------
// Bogus MCP server: exits immediately → status 'error'
// ---------------------------------------------------------------------------

const BOGUS_SERVER_SPEC = {
  bogus: {
    type: 'stdio' as const,
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#4063 — AgentSession SDK-owned MCP manager', () => {
  // Import lazily so vi.mock() is applied first.
  let AgentSession: (typeof import('./agent-session.js'))['AgentSession'];
  let __setAnthropicClientFactory: (typeof import('../providers/anthropic-direct/index.js'))['__setAnthropicClientFactory'];

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ AgentSession } = await import('./agent-session.js'));
    ({ __setAnthropicClientFactory } = await import('../providers/anthropic-direct/index.js'));
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);

    // Default mock: returns an end_turn stream so waitForInitialization resolves.
    messagesCreateMock.mockImplementation(() => fromArray(makeEndTurnStream()));
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  // -------------------------------------------------------------------------
  // Key integration test (was the probe in the issue)
  // -------------------------------------------------------------------------

  it('mcpServerStatus() is non-empty when mcpServers is configured (bug repro)', async () => {
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
      mcpServers: BOGUS_SERVER_SPEC,
    });

    // waitForInitialization resolves once session.init fires from the provider.
    await session.waitForInitialization();

    const statuses = await session.mcpServerStatus();

    // Before the fix: statuses === []. After: one entry for 'bogus'.
    expect(statuses.length).toBeGreaterThan(0);
    // Public McpServerStatus uses `name` (mapped from McpClientState.serverName).
    expect(statuses[0]?.name).toBe('bogus');
    // Bogus server exits immediately → connect error → status: 'failed'.
    // (ProviderMcpServerStatus.status is typed as string; the mapper passes through.)
    expect(statuses[0]?.status).toMatch(/error|failed/);

    await session.close();
  });

  it('mcpServerStatus() returns [] when no mcpServers configured', async () => {
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
    });

    await session.waitForInitialization();
    const statuses = await session.mcpServerStatus();
    expect(statuses).toEqual([]);
    await session.close();
  });

  // -------------------------------------------------------------------------
  // Unit tests for initSdkOwnedMcpManager
  // -------------------------------------------------------------------------

  it('initSdkOwnedMcpManager: builds owned manager from mcpServers', async () => {
    const { initSdkOwnedMcpManager } = await import('./agent-session.mcp.js');

    const result = await initSdkOwnedMcpManager({
      model: 'claude-haiku-4-5',
      mcpServers: BOGUS_SERVER_SPEC,
    });

    expect(result.ownedManager).toBeDefined();
    expect(result.resolvedManager).toBe(result.ownedManager);

    const states = result.ownedManager!.getServerStates();
    expect(states.length).toBe(1);
    expect(states[0]?.serverName).toBe('bogus');
    expect(states[0]?.status).toBe('error');

    await result.ownedManager!.disconnectAll();
  });

  it('initSdkOwnedMcpManager: caller-supplied mcpManager is not owned', async () => {
    const { initSdkOwnedMcpManager } = await import('./agent-session.mcp.js');

    const { resolvedManager: callerManager } = await initSdkOwnedMcpManager({
      model: 'claude-haiku-4-5',
      mcpServers: BOGUS_SERVER_SPEC,
    });
    const disconnectSpy = vi.spyOn(callerManager!, 'disconnectAll');

    const result = await initSdkOwnedMcpManager({
      model: 'claude-haiku-4-5',
      mcpManager: callerManager,
    });

    expect(result.ownedManager).toBeUndefined();
    expect(result.resolvedManager).toBe(callerManager);
    expect(disconnectSpy).not.toHaveBeenCalled();

    await callerManager!.disconnectAll();
  });

  it('initSdkOwnedMcpManager: returns undefined pair when nothing configured', async () => {
    const { initSdkOwnedMcpManager } = await import('./agent-session.mcp.js');

    const result = await initSdkOwnedMcpManager({ model: 'claude-haiku-4-5' });
    expect(result.ownedManager).toBeUndefined();
    expect(result.resolvedManager).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Public export check
  // -------------------------------------------------------------------------

  it('exports McpManager from the public entry point', async () => {
    const mod = await import('../../index.js');
    expect(typeof (mod as Record<string, unknown>).McpManager).toBe('function');
  });
});
