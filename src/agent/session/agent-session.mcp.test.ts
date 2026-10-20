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

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { McpManager } from '../mcp/manager.js';
import type { ModelProvider, ProviderEvent, ProviderQuery, ProviderQueryArgs } from '../provider.js';
import type { AgentConfig } from '../types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MCP_FIXTURE = resolve(__dirname, '../mcp/__fixtures__/test-server.mjs');

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

/** Minimal stream with text content: used for sendMessage turns. */
function makeTextStream(text: string): RawMessageStreamEvent[] {
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
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Minimal end-turn stream (no content): sufficient for waitForInitialization in tests that don't sendMessage. */
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
    // TS4111: index signature access must use bracket notation.
    expect(typeof (mod as Record<string, unknown>)['McpManager']).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Required regression tests (spec items a, b, c)
  // -------------------------------------------------------------------------

  // (a) sendMessage reaches the provider on an MCP-configured session.
  // Confirms the Phase-2 rebuilt provider reads from the same inputStream
  // that sendMessage pushes to (item 1 fix). Fails without the fix because
  // buildProviderLifecycle creates a fresh QueryInputStream whose iterable
  // the rebuilt provider reads, while sendMessage pushes to the Phase-1
  // inputStream — causing sendMessage to stall indefinitely.
  it('(a) sendMessage reaches provider after MCP init (stream not discarded)', async () => {
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
      mcpServers: BOGUS_SERVER_SPEC,
    });

    await session.waitForInitialization();

    // Queue a text response for the sendMessage turn.
    messagesCreateMock.mockImplementationOnce(() => fromArray(makeTextStream('hello back')));

    // sendMessage must complete (not stall). Race against a timeout so the
    // test fails fast instead of hanging on the unfixed code.
    const result = await Promise.race([
      session.sendMessage('hello'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sendMessage stalled — Phase-1 stream discarded')), 5000),
      ),
    ]);

    expect(result).toBeDefined();
    await session.close();
  });

  // (b) waitForInitialization() rejects when McpManager.fromConfig rejects.
  // Without the item-2 fix the rejection path is never wired, so
  // waitForInitialization() hangs forever.
  it('(b) waitForInitialization() rejects when McpManager.fromConfig throws', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');
    const fromConfigSpy = vi.spyOn(McpManagerCls, 'fromConfig').mockRejectedValueOnce(
      new Error('alwaysLoad server failed'),
    );

    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
      mcpServers: BOGUS_SERVER_SPEC,
    });

    // Must reject with the MCP error, not hang. The hang sentinel also rejects,
    // so the assertion pins the message: a bare `.rejects.toThrow()` would
    // pass on the hang it is meant to catch.
    await expect(
      Promise.race([
        session.waitForInitialization(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('waitForInitialization hung — rejection not wired')), 5000),
        ),
      ]),
    ).rejects.toThrow('alwaysLoad server failed');

    fromConfigSpy.mockRestore();
    // close() is best-effort after a rejection; swallow errors.
    await session.close().catch(() => {});
  });

  // (c) close() before fromConfig resolves: owned manager disconnected, caller
  // manager untouched. Without the item-3 fix the owned manager's disconnectAll
  // is never called (ownedMcpManager is undefined at close() time), leaving
  // stdio children alive after the session ends.
  it('(c) close() before fromConfig resolves → owned manager disconnected; caller manager untouched', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');

    // Build a real manager to use as the "caller-supplied" reference.
    const callerManager = await McpManagerCls.fromConfig(BOGUS_SERVER_SPEC);
    const callerDisconnectSpy = vi.spyOn(callerManager, 'disconnectAll');

    // Delay fromConfig by a controlled promise so we can close() first.
    let resolveFromConfig!: () => void;
    let capturedOwnedManager: import('../mcp/manager.js').McpManager | undefined;
    const fromConfigDeferred = new Promise<import('../mcp/manager.js').McpManager>(
      (resolve) => {
        resolveFromConfig = () => {
          // Create a minimal stub owned manager so we can spy on its disconnect.
          const stub = {
            disconnectAll: vi.fn().mockResolvedValue(undefined),
            getServerStates: vi.fn().mockReturnValue([]),
          } as unknown as import('../mcp/manager.js').McpManager;
          capturedOwnedManager = stub;
          resolve(stub);
        };
      },
    );
    const fromConfigSpy = vi.spyOn(McpManagerCls, 'fromConfig').mockReturnValueOnce(fromConfigDeferred);

    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
      mcpServers: BOGUS_SERVER_SPEC,
    });

    // Close immediately before fromConfig resolves.
    await session.close();

    // Now resolve fromConfig — the owned manager should be disconnected inline.
    resolveFromConfig();
    // Flush microtasks so the .then() in startMcpInit runs.
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedOwnedManager).toBeDefined();
    expect(
      (capturedOwnedManager as unknown as { disconnectAll: ReturnType<typeof vi.fn> }).disconnectAll,
    ).toHaveBeenCalledOnce();
    expect(callerDisconnectSpy).not.toHaveBeenCalled();

    fromConfigSpy.mockRestore();
    await callerManager.disconnectAll();
  });

  // -------------------------------------------------------------------------
  // End-to-end: real stdio fixture connected through an SDK AgentSession
  // (#4075 item 1 — #4063 acceptance: "an SDK session configured with a
  // working stdio server can call its tools")
  // -------------------------------------------------------------------------

  it('(e2e) mcp__* tools from a working stdio fixture reach the provider', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');

    // Build the real manager from the fixture so we can spy on it — the
    // session will receive it as a caller-supplied mcpManager (avoiding the
    // timing-sensitive fromConfig spawn inside AgentSession init).
    const manager = await McpManagerCls.fromConfig({
      testsrv: { type: 'stdio', command: process.execPath, args: [MCP_FIXTURE] },
    });

    try {
      const states = manager.getServerStates();
      expect(states.length).toBe(1);
      expect(states[0]?.serverName).toBe('testsrv');
      expect(states[0]?.status).toBe('connected');
      // The fixture exposes 3 tools (add, echo, boom).
      expect(states[0]?.toolCount).toBe(3);

      // Wire names are prefixed: mcp__<serverName>__<toolName>.
      const wireNames = manager.getMcpToolWireNames();
      expect(wireNames).toContain('mcp__testsrv__add');
      expect(wireNames).toContain('mcp__testsrv__echo');
      expect(wireNames).toContain('mcp__testsrv__boom');

      // Build an AgentSession with the pre-built manager — the provider will
      // see mcp__testsrv__* tools in its tool list.
      const session = new AgentSession({
        model: 'claude-haiku-4-5',
        apiKey: 'test-key',
        persistSession: false,
        cwd: process.cwd(),
        mcpManager: manager,
      });

      await session.waitForInitialization();

      // mcpServerStatus() should reflect the connected fixture server.
      const statuses = await session.mcpServerStatus();
      expect(statuses.length).toBeGreaterThan(0);
      const srv = statuses.find((s) => s.name === 'testsrv');
      expect(srv).toBeDefined();
      expect(srv?.status).toMatch(/connected/);
      // toolCount must be forwarded through the provider boundary (#4122).
      expect(srv?.toolCount).toBe(3);

      await session.close();
    } finally {
      await manager.disconnectAll();
    }
  });

  // (e2e-mcpServers) auto-build path: AgentSession configured with mcpServers
  // (no pre-built mcpManager) connects to the stdio fixture and surfaces its
  // tools through mcpServerStatus().
  //
  // This exercises the acceptance criterion from #4092: "an SDK session
  // configured with mcpServers can call its tools" (the auto-build path with a
  // working server). The beforeEach Anthropic mock resolves
  // waitForInitialization() via the end-turn stream it returns; this coupling
  // is intentional — the mock stands in for a real Anthropic provider so the
  // test stays self-contained without network access.
  it('(e2e-mcpServers) mcpServers auto-build path: session connects fixture and reports toolCount', async () => {
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
      mcpServers: {
        testsrv: { type: 'stdio', command: process.execPath, args: [MCP_FIXTURE] },
      },
    });

    await session.waitForInitialization();

    const statuses = await session.mcpServerStatus();
    expect(statuses.length).toBeGreaterThan(0);
    const srv = statuses.find((s) => s.name === 'testsrv');
    expect(srv).toBeDefined();
    expect(srv?.status).toMatch(/connected/);
    // toolCount forwarded through the provider boundary (#4122).
    expect(srv?.toolCount).toBe(3);

    await session.close();
  });

  // (d) Phase 2 rebuilds the provider ONLY when the SDK built the manager.
  // A caller-supplied manager (daemon, CLI, Telegram) is already wired into
  // the Phase-1 provider; rebuilding for it ran provider.query() twice and
  // broke scheduler.test.ts "MCP fixture wiring" (land round 3, #4069).
  it('(d) caller-supplied mcpManager → provider.query() runs once; SDK-built → rebuilt with the manager', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');

    const run = async (extra: Pick<AgentConfig, 'mcpManager'> | Pick<AgentConfig, 'mcpServers'>) => {
      const seen: Array<McpManager | undefined> = [];
      const provider: ModelProvider = {
        name: 'query-counting-provider',
        query(args: ProviderQueryArgs): ProviderQuery {
          seen.push(args.config.mcpManager);
          let closed = false;
          return {
            async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
              yield {
                type: 'session.init',
                info: {
                  sessionId: 'query-counting-session', model: 'sonnet', permissionMode: 'default',
                  cwd: args.config.cwd, tools: [], slashCommands: [], skills: [], plugins: [],
                  mcpServers: [], apiKeySource: 'api-key', version: 'test',
                },
              };
              while (!closed) await new Promise((r) => setTimeout(r, 5));
            },
            async interrupt() {}, async setModel() {}, async setPermissionMode() {},
            async supportedCommands() { return []; }, async supportedModels() { return []; },
            async supportedAgents() { return []; },
            async getContextUsage() { return { tools: [], isAutoCompactEnabled: false, apiUsage: null }; },
            async mcpServerStatus() { return []; },
            async accountInfo() { return { subscriptionType: 'api-key' }; },
            async rewindFiles() { return { canRewind: false }; },
            close() { closed = true; },
          } as unknown as ProviderQuery;
        },
      } as unknown as ModelProvider;
      const session = new AgentSession({ model: 'claude-haiku-4-5', persistSession: false, cwd: process.cwd(), provider, ...extra });
      await session.waitForInitialization();
      await session.close();
      return seen;
    };

    const callerManager = await McpManagerCls.fromConfig({});
    const callerSeen = await run({ mcpManager: callerManager });
    expect(callerSeen).toEqual([callerManager]);

    const sdkManager = await McpManagerCls.fromConfig({});
    const spy = vi.spyOn(McpManagerCls, 'fromConfig').mockResolvedValueOnce(sdkManager);
    const sdkSeen = await run({ mcpServers: BOGUS_SERVER_SPEC });
    expect(sdkSeen).toEqual([undefined, sdkManager]);
    spy.mockRestore();

    await callerManager.disconnectAll();
  });

  // -------------------------------------------------------------------------
  // (e) Session-level failure notice wiring (#4064) — item 4
  // The MCP failure notice must reach the first user-turn content the provider
  // receives for BOTH (a) a caller-supplied mcpManager and (b) an SDK-built
  // manager from mcpServers. Asserts [MCP] + server name appear exactly once.
  // -------------------------------------------------------------------------

  it('(e) failure notice reaches first turn for a caller-supplied mcpManager', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');

    // Build a real manager whose server is in error state (bogus exits immediately).
    const callerManager = await McpManagerCls.fromConfig(BOGUS_SERVER_SPEC);
    // Verify it recorded an error state before proceeding.
    const states = callerManager.getServerStates();
    expect(states.length).toBeGreaterThan(0);
    expect(states[0]?.status).toBe('error');

    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));

    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
      mcpManager: callerManager,
    });

    await session.waitForInitialization();
    await session.sendMessage('hello');

    // Inspect what messages.create received — framework context prepended to first user message.
    const calls = messagesCreateMock.mock.calls as Array<[{ messages: Array<{ role: string; content: unknown }> }]>;
    const allContent = calls
      .flatMap(([args]) => args.messages)
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    expect(allContent).toContain('[MCP]');
    expect(allContent).toContain('bogus');

    // Appears exactly once (not duplicated across turns).
    const mcpCount = (allContent.match(/\[MCP\]/g) ?? []).length;
    expect(mcpCount).toBe(1);

    await session.close();
    await callerManager.disconnectAll();
  });

  it('(e) failure notice reaches first turn for an SDK-built manager from mcpServers', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');

    // Spy: let fromConfig run for real so the server actually errors.
    const fromConfigSpy = vi.spyOn(McpManagerCls, 'fromConfig');

    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));

    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'test-key',
      persistSession: false,
      cwd: process.cwd(),
      mcpServers: BOGUS_SERVER_SPEC,
    });

    await session.waitForInitialization();
    await session.sendMessage('hello');

    // Inspect what messages.create received.
    const calls = messagesCreateMock.mock.calls as Array<[{ messages: Array<{ role: string; content: unknown }> }]>;
    const allContent = calls
      .flatMap(([args]) => args.messages)
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    expect(allContent).toContain('[MCP]');
    expect(allContent).toContain('bogus');

    // Appears exactly once.
    const mcpCount = (allContent.match(/\[MCP\]/g) ?? []).length;
    expect(mcpCount).toBe(1);

    fromConfigSpy.mockRestore();
    await session.close();
  });

  // -------------------------------------------------------------------------
  // (f) Spec item 1 + 2: Phase-1 provider close() rejection is caught/logged
  // and Phase-2 rebuild still settles waitForInitialization(). Uses an injected
  // provider so close() is controllable.
  //
  // Also verifies spec item 2: isClosed() checked after the awaited close() so
  // a concurrent AgentSession.close() prevents the Phase-2 rebuild from running.
  // -------------------------------------------------------------------------

  it('(f) Phase-1 provider close() rejection is caught and Phase-2 rebuild/settlement proceeds', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');

    const closeCalls: string[] = [];

    const makeQuery = (label: string, closeRejects = false): ProviderQuery => {
      let closed = false;
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield {
            type: 'session.init',
            info: {
              sessionId: `${label}-session`, model: 'sonnet', permissionMode: 'default',
              cwd: process.cwd(), tools: [], slashCommands: [], skills: [], plugins: [],
              mcpServers: [], apiKeySource: 'api-key', version: 'test',
            },
          };
          while (!closed) await new Promise((r) => setTimeout(r, 5));
        },
        async interrupt() {}, async setModel() {}, async setPermissionMode() {},
        async supportedCommands() { return []; }, async supportedModels() { return []; },
        async supportedAgents() { return []; },
        async getContextUsage() { return { tools: [], isAutoCompactEnabled: false, apiUsage: null }; },
        async mcpServerStatus() { return []; },
        async accountInfo() { return { subscriptionType: 'api-key' }; },
        async rewindFiles() { return { canRewind: false }; },
        close(): void | Promise<void> {
          closed = true;
          closeCalls.push(label);
          if (closeRejects) return Promise.reject(new Error(`${label} close() rejected`));
        },
      } as unknown as ProviderQuery;
    };

    let callCount = 0;
    const provider: ModelProvider = {
      name: 'close-tracking-provider',
      query(_args: ProviderQueryArgs): ProviderQuery {
        callCount += 1;
        // Phase-1 close() rejects; Phase-2 closes normally.
        return makeQuery(callCount === 1 ? 'phase-1' : 'phase-2', callCount === 1);
      },
    } as unknown as ModelProvider;

    // Use mcpServers so Phase 2 triggers a rebuild (SDK-built manager path).
    const sdkManager = await McpManagerCls.fromConfig({});
    const spy = vi.spyOn(McpManagerCls, 'fromConfig').mockResolvedValueOnce(sdkManager);

    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      persistSession: false,
      cwd: process.cwd(),
      provider,
      mcpServers: BOGUS_SERVER_SPEC,
    });

    // waitForInitialization must resolve even though Phase-1 close() rejected.
    await session.waitForInitialization();

    // Phase-1 query must have been closed (and its rejection swallowed).
    expect(closeCalls).toContain('phase-1');
    // Two queries were built: one for Phase 1, one for Phase 2.
    expect(callCount).toBe(2);

    await session.close();
    spy.mockRestore();
    await sdkManager.disconnectAll();
  });

  it('(f) AgentSession.close() racing pending Phase-1 close prevents Phase-2 rebuild', async () => {
    const { McpManager: McpManagerCls } = await import('../mcp/manager.js');

    // Two-deferred design: closeEntered resolves the moment Phase-1 close() is
    // called (so we know Phase 2 is blocked inside it); phase1ClosedPromise is
    // the gate that keeps Phase-1 close() suspended until we release it.
    let signalCloseEntered!: () => void;
    const closeEntered = new Promise<void>((res) => { signalCloseEntered = res; });
    let phase1CloseResolve!: () => void;
    const phase1ClosedPromise = new Promise<void>((res) => { phase1CloseResolve = res; });

    const makeQuery = (label: string): ProviderQuery => {
      let closed = false;
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield {
            type: 'session.init',
            info: {
              sessionId: `${label}-session`, model: 'sonnet', permissionMode: 'default',
              cwd: process.cwd(), tools: [], slashCommands: [], skills: [], plugins: [],
              mcpServers: [], apiKeySource: 'api-key', version: 'test',
            },
          };
          while (!closed) await new Promise((r) => setTimeout(r, 5));
        },
        async interrupt() {}, async setModel() {}, async setPermissionMode() {},
        async supportedCommands() { return []; }, async supportedModels() { return []; },
        async supportedAgents() { return []; },
        async getContextUsage() { return { tools: [], isAutoCompactEnabled: false, apiUsage: null }; },
        async mcpServerStatus() { return []; },
        async accountInfo() { return { subscriptionType: 'api-key' }; },
        async rewindFiles() { return { canRewind: false }; },
        close(): Promise<void> {
          closed = true;
          if (label === 'phase-1') {
            // Signal that Phase-1 close() has been entered, then suspend.
            signalCloseEntered();
            return phase1ClosedPromise;
          }
          return Promise.resolve();
        },
      } as unknown as ProviderQuery;
    };

    let callCount = 0;
    const provider: ModelProvider = {
      name: 'race-provider',
      query(_args: ProviderQueryArgs): ProviderQuery {
        callCount += 1;
        return makeQuery(callCount === 1 ? 'phase-1' : 'phase-2');
      },
    } as unknown as ModelProvider;

    const sdkManager = await McpManagerCls.fromConfig({});
    const spy = vi.spyOn(McpManagerCls, 'fromConfig').mockResolvedValueOnce(sdkManager);

    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      persistSession: false,
      cwd: process.cwd(),
      provider,
      mcpServers: BOGUS_SERVER_SPEC,
    });

    // Wait until Phase-2 has entered Phase-1 close() and is suspended there.
    // This is deterministic: closeEntered resolves inside close() itself,
    // guaranteeing Phase 2 is blocked before we call AgentSession.close().
    await closeEntered;

    // Now Phase-2 is suspended inside Phase-1 close(). Call AgentSession.close()
    // so it sets currentState='closed', then release the Phase-1 close() gate
    // so the isClosed() re-check inside Phase-2 fires and skips the rebuild.
    const closePromise = session.close();
    phase1CloseResolve();
    await closePromise;

    // Phase-2 rebuild must NOT have run because isClosed() returned true.
    expect(callCount).toBe(1);

    spy.mockRestore();
    await sdkManager.disconnectAll();
  });
});
