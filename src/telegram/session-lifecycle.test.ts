/**
 * Tests for finalizeTelegramSession (session-lifecycle.ts).
 *
 * Regression guard for #3289 item 1: `finalizeTelegramSession` MUST forward
 * `thinking` and `effort` from `sessionConfig` into the constructed session
 * (via `constructTelegramSession`). Earlier code cherry-picked ~16 fields but
 * omitted these two, so AFK_THINKING / AFK_EFFORT were silently dropped at
 * the final construction step even though SessionManager had threaded them into
 * `sessionConfig` correctly.
 *
 * The tests mock all of `finalizeTelegramSession`'s volatile dependencies so
 * the suite has no network I/O, no disk I/O beyond a temp AFK_HOME, and no
 * real session construction.
 *
 * Key dependency mocks:
 *   - `constructTelegramSession` (./construct-session.js) — captured via spy to
 *     inspect the baseConfig argument that reaches it.
 *   - `attachMcpCleanup` (./mcp-session.js) — identity passthrough: returns
 *     whatever `constructTelegramSession` returned.
 *   - `assembleSystemPrompt` (../agent/routing-directive.js) — echoes input.
 *   - `createTelegramAfkHookBundle` (./afk-hook-bundle.js) — minimal stub.
 *   - `seedPersistedGrants` (../agent/permissions-store.js) — no-op.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module-level mocks — must appear BEFORE the subject is imported.
// ---------------------------------------------------------------------------

vi.mock('./construct-session.js', () => ({
  constructTelegramSession: vi.fn(),
}));

vi.mock('./mcp-session.js', () => ({
  attachMcpCleanup: vi.fn(),
}));

vi.mock('../agent/routing-directive.js', () => ({
  assembleSystemPrompt: vi.fn((prompt: string) => prompt),
}));

vi.mock('./afk-hook-bundle.js', () => ({
  createTelegramAfkHookBundle: vi.fn(() => ({
    registry: { dispatch: vi.fn() },
  })),
}));

vi.mock('../agent/permissions-store.js', () => ({
  seedPersistedGrants: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock calls so mocked modules are in effect.
// ---------------------------------------------------------------------------

import { finalizeTelegramSession } from './session-lifecycle.js';
import { constructTelegramSession } from './construct-session.js';
import { attachMcpCleanup } from './mcp-session.js';
import type { AgentConfig } from '../agent/types.js';
import type { AgentSession } from '../agent/session.js';
import type { ModelProvider } from '../agent/provider.js';
import type { TelegramSessionBuildContext } from './session-context.js';
import type { TelegramExecutorWiring } from './wire-telegram-executors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal AgentSession stub with all methods finalizeTelegramSession touches. */
function makeStubSession(): AgentSession {
  return {
    sessionId: 'stub-session',
    wireStopHook: vi.fn(),
    queueFrameworkContext: vi.fn(),
    getSessionMetadata: vi.fn(() => ({ permissionMode: 'default' })),
    close: vi.fn(async () => {}),
    abort: vi.fn(),
    reset: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ role: 'assistant' as const, content: '', timestamp: new Date() })),
    getOutputStream: vi.fn(async function * () { yield { type: 'done' as const }; }),
  } as unknown as AgentSession;
}

/** Minimal provider stub. */
function makeStubProvider(): ModelProvider & { addReadRoot: () => void; addWriteRoot: () => void } {
  return {
    name: 'stub',
    addReadRoot: vi.fn(),
    addWriteRoot: vi.fn(),
    close: vi.fn(),
  } as unknown as ModelProvider & { addReadRoot: () => void; addWriteRoot: () => void };
}

/** Minimal TelegramExecutorWiring stub. */
function makeStubWiring(): TelegramExecutorWiring {
  return {
    executors: {} as TelegramExecutorWiring['executors'],
    backgroundRegistry: {} as TelegramExecutorWiring['backgroundRegistry'],
    bgNotifier: {} as TelegramExecutorWiring['bgNotifier'],
    drainSubagents: undefined,
    bindSession: vi.fn(),
  };
}

/**
 * Build a minimal `TelegramSessionBuildContext` from a `sessionConfig` override.
 * All the non-config fields are stubs — only sessionConfig matters for
 * thinking/effort forwarding.
 */
function makeCtx(sessionConfig: AgentConfig, tmpHome: string): TelegramSessionBuildContext {
  return {
    sessionConfig,
    config: {
      autoRouting: undefined,
      temperature: undefined,
    } as unknown as TelegramSessionBuildContext['config'],
    layeredBasePrompt: 'base-prompt',
    sessionCwd: tmpHome,
    maxOutputTokens: undefined,
    maxToolUseIterations: undefined,
    traceWriter: null,
    mcpManager: undefined,
    memoryStore: undefined as unknown as TelegramSessionBuildContext['memoryStore'],
    reportSession: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('finalizeTelegramSession — thinking/effort forwarding (#3289)', () => {
  let tmpHome: string;
  let savedAfkHome: string | undefined;

  beforeEach(async () => {
    // Redirect AFK_HOME to a fresh temp dir so no test writes to the real ~/.afk.
    tmpHome = await mkdtemp(join(tmpdir(), 'afk-lifecycle-test-'));
    savedAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = tmpHome;

    // Reset all mocks before each test.
    vi.mocked(constructTelegramSession).mockReset();
    vi.mocked(attachMcpCleanup).mockReset();

    // Default stub: constructTelegramSession → stubSession,
    // attachMcpCleanup → identity (returns the session passed to it).
    const stub = makeStubSession();
    vi.mocked(constructTelegramSession).mockReturnValue(stub);
    vi.mocked(attachMcpCleanup).mockImplementation((session) => session);
  });

  afterEach(async () => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Item 1: thinking survives through finalizeTelegramSession
  // -------------------------------------------------------------------------

  it('forwards thinking config to constructTelegramSession when set', () => {
    const thinkingConfig = { type: 'enabled' as const, budgetTokens: 5000 };
    const sessionConfig: AgentConfig = {
      model: 'claude-sonnet',
      apiKey: 'test-key',
      thinking: thinkingConfig,
    };

    finalizeTelegramSession(
      makeStubProvider(),
      {},
      makeCtx(sessionConfig, tmpHome),
      makeStubWiring(),
    );

    expect(vi.mocked(constructTelegramSession)).toHaveBeenCalledOnce();
    const capturedBaseConfig = vi.mocked(constructTelegramSession).mock.calls[0]![0];
    expect(capturedBaseConfig.thinking).toEqual(thinkingConfig);
  });

  // -------------------------------------------------------------------------
  // Item 2: effort survives through finalizeTelegramSession
  // -------------------------------------------------------------------------

  it('forwards effort level to constructTelegramSession when set', () => {
    const sessionConfig: AgentConfig = {
      model: 'claude-sonnet',
      apiKey: 'test-key',
      effort: 'high',
    };

    finalizeTelegramSession(
      makeStubProvider(),
      {},
      makeCtx(sessionConfig, tmpHome),
      makeStubWiring(),
    );

    expect(vi.mocked(constructTelegramSession)).toHaveBeenCalledOnce();
    const capturedBaseConfig = vi.mocked(constructTelegramSession).mock.calls[0]![0];
    expect(capturedBaseConfig.effort).toBe('high');
  });

  // -------------------------------------------------------------------------
  // Item 3: neither thinking nor effort appear when unset
  // -------------------------------------------------------------------------

  it('omits thinking and effort from constructTelegramSession when not present in sessionConfig', () => {
    const sessionConfig: AgentConfig = {
      model: 'claude-sonnet',
      apiKey: 'test-key',
      // thinking and effort intentionally absent
    };

    finalizeTelegramSession(
      makeStubProvider(),
      {},
      makeCtx(sessionConfig, tmpHome),
      makeStubWiring(),
    );

    expect(vi.mocked(constructTelegramSession)).toHaveBeenCalledOnce();
    const capturedBaseConfig = vi.mocked(constructTelegramSession).mock.calls[0]![0];
    // Neither key should be present — undefined means "not set", not "set to undefined".
    expect(capturedBaseConfig.thinking).toBeUndefined();
    expect(capturedBaseConfig.effort).toBeUndefined();
    expect('thinking' in capturedBaseConfig).toBe(false);
    expect('effort' in capturedBaseConfig).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Bonus: both thinking and effort set simultaneously
  // -------------------------------------------------------------------------

  it('forwards both thinking and effort when both are set', () => {
    const thinkingConfig = { type: 'adaptive' as const };
    const sessionConfig: AgentConfig = {
      model: 'claude-sonnet',
      apiKey: 'test-key',
      thinking: thinkingConfig,
      effort: 'xhigh',
    };

    finalizeTelegramSession(
      makeStubProvider(),
      {},
      makeCtx(sessionConfig, tmpHome),
      makeStubWiring(),
    );

    const capturedBaseConfig = vi.mocked(constructTelegramSession).mock.calls[0]![0];
    expect(capturedBaseConfig.thinking).toEqual(thinkingConfig);
    expect(capturedBaseConfig.effort).toBe('xhigh');
  });
});
