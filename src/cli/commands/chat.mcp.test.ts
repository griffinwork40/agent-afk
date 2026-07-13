/**
 * Focused regression tests for one-shot chat MCP behavior in `afk chat`.
 *
 * Verifies that configuring an MCP server (using the stdio fixture) wires
 * the MCP tools into the provider's allowedTools set, and that omitting config
 * leaves the default (no MCP tools) behavior unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../../agent/mcp/__fixtures__/test-server.mjs');

async function* makeStream(events: OutputEvent[]): AsyncIterable<OutputEvent> {
  for (const event of events) {
    yield event;
  }
}

// ---------------------------------------------------------------------------
// Mocks — hoisted above module imports.
// ---------------------------------------------------------------------------

vi.mock('../../agent/session.js', () => {
  const MockAgentSession = vi.fn().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ content: 'pong', timestamp: new Date() }),
    sendMessageStream: vi.fn().mockReturnValue(makeStream([{ type: 'done' }])),
    getLastResponseMetadata: vi.fn().mockReturnValue(null),
    getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
    sessionId: 'mock-session-id',
    abortSignal: new AbortController().signal,
  }));
  return { AgentSession: MockAgentSession };
});

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ model: 'sonnet', maxTokens: 4096 })),
}));

vi.mock('../shared-helpers.js', () => ({
  parseThinking: vi.fn(() => undefined),
  parseEffort: vi.fn(() => undefined),
  parseBudget: vi.fn(() => undefined),
  parseMaxOutputTokens: vi.fn(() => undefined),
  parseProvider: vi.fn(() => undefined),
  getApiKey: vi.fn(() => 'test-key'),
  getApiKeyForModel: vi.fn(() => 'test-key'),
  getModel: vi.fn(() => 'sonnet'),
  getThinking: vi.fn(() => undefined),
  getEffort: vi.fn(() => undefined),
  getMaxBudgetUsd: vi.fn(() => undefined),
  getTaskBudget: vi.fn(() => undefined),
  getMaxOutputTokens: vi.fn(() => undefined),
  getMaxToolUseIterations: vi.fn(() => undefined),
  getDefaultSubagentModel: vi.fn(() => 'sonnet'),
  loadSystemPrompt: vi.fn(() => undefined),
  loadConfigSystemPrompt: vi.fn(() => undefined),
  resolveBaseSystemPrompt: vi.fn(() => ({ prompt: undefined, source: 'none' })),
}));

vi.mock('../../agent/routing-directive.js', () => ({
  assembleSystemPrompt: vi.fn(() => undefined),
}));

vi.mock('../../agent/default-hook-registry.js', () => ({
  createDefaultHookRegistry: vi.fn(() => ({ registry: {} })),
}));

vi.mock('../../agent/memory/index.js', () => ({
  MemoryStore: vi.fn(() => ({ close: vi.fn() })),
  injectHotMemory: (c: unknown) => c,
  MEMORY_TOOL_NAMES: [],
}));

vi.mock('../../agent/subagent.js', () => ({
  SubagentManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../agent/tools/subagent-executor.js', () => ({
  SubagentExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../agent/tools/skill-executor.js', () => ({
  SkillExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../agent/tools/compose-executor.js', () => ({
  ComposeExecutor: vi.fn().mockImplementation(() => ({})),
}));

// chat.ts awaits ensurePluginEntrypointsLoaded() before session construction
// (plugin `main` entrypoints must run before the skill manifest is built). This
// test isolates MCP wiring, so stub it to a no-op — the real impl scans the
// filesystem for plugin roots, which is out of scope here.
vi.mock('../../agent/tools/skill-bridge.js', () => ({
  ensurePluginEntrypointsLoaded: vi.fn(async () => {}),
  discoverPluginAgents: vi.fn(() => []),
}));

vi.mock('../../agent/tools/nesting.js', () => ({
  createChildProviderFactory: vi.fn(() => ({})),
  createChildSkillExecutorFactory: vi.fn(() => ({})),
}));

vi.mock('../../agent/providers/anthropic-direct/index.js', () => ({
  AnthropicDirectProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../agent/tools/schemas.js', () => ({
  BUILTIN_TOOL_NAMES: [],
}));

vi.mock('../../agent/trace/factory.js', () => ({
  createDefaultTraceWriter: vi.fn(() => null),
}));

vi.mock('./interactive/progress-banner.js', () => ({
  formatSubagentCompletion: vi.fn(() => ''),
}));

vi.mock('./interactive/worktree.js', () => ({
  setupWorktree: vi.fn(),
}));

vi.mock('../errors/index.js', () => ({
  handleCommandError: vi.fn((err: unknown): never => {
    throw err instanceof Error ? err : new Error(String(err));
  }),
}));

vi.mock('../resume-session.js', () => ({
  resolveResumeTarget: vi.fn(() => undefined),
  resumeConfigFor: vi.fn(() => ({})),
}));

vi.mock('../session-store.js', () => ({
  saveSession: vi.fn(() => '/tmp/mock.json'),
  findSession: vi.fn(() => undefined),
}));

vi.mock('../slash/session-stats.js', () => ({
  createSessionStats: vi.fn(() => ({
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  })),
  recordTurn: vi.fn(() => ({ user: '', assistant: '', timestamp: Date.now() })),
}));

// We also mock the import config logic to return empty lists so we only load our override mcp config
vi.mock('../../config/import-sources.js', () => ({
  loadImportFromConfig: vi.fn(() => ({})),
  resolveImportedRoots: vi.fn(() => ({ mcpConfigs: [] })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AgentSession } from '../../agent/session.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { McpManager } from '../../agent/mcp/index.js';
import { registerChatCommand } from './chat.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runChat(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerChatCommand(program);
  await program.parseAsync(['node', 'afk', 'chat', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk chat — MCP integration', () => {
  let tempDir: string;
  let mcpConfigPath: string;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.mocked(AgentSession).mockClear();
    vi.mocked(AnthropicDirectProvider).mockClear();
    // Force non-TTY for headless runChat execution
    // @ts-expect-error - overriding readonly property for tests
    process.stdin.isTTY = false;
    process.exitCode = undefined;

    tempDir = mkdtempSync(join(tmpdir(), 'afk-chat-mcp-test-'));
    vi.stubEnv('AFK_HOME', tempDir);
    mcpConfigPath = join(tempDir, 'mcp.json');
  });

  afterEach(() => {
    // @ts-expect-error - restore
    process.stdin.isTTY = originalIsTTY;
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('wires up MCP servers, handshake succeeds, exposes tools, and disconnects after session close', async () => {
    const disconnectSpy = vi.spyOn(McpManager.prototype, 'disconnectAll');
    try {
      const mcpConfig = {
        mcpServers: {
          testsrv: {
            type: 'stdio',
            command: process.execPath,
            args: [FIXTURE],
          },
        },
      };
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf-8');

      await runChat('hello world', '--mcp-config', mcpConfigPath, '--format', 'json');

      // Verify AnthropicDirectProvider was initialized with the MCP tools.
      expect(vi.mocked(AnthropicDirectProvider)).toHaveBeenCalled();
      const firstCallArgs = vi.mocked(AnthropicDirectProvider).mock.calls[0]?.[0];
      expect(firstCallArgs).toBeDefined();
      expect(firstCallArgs?.permissions?.allowedTools).toEqual(
        expect.arrayContaining([
          'mcp__testsrv__add',
          'mcp__testsrv__boom',
          'mcp__testsrv__echo',
        ]),
      );

      // Verify that the provider also received mcpManager.
      expect(firstCallArgs?.mcpManager).toBeDefined();

      // Verify cleanup ordering: the agent session closes before MCP children disconnect.
      const sessionInstance = vi.mocked(AgentSession).mock.results[0]?.value as { close: ReturnType<typeof vi.fn> } | undefined;
      expect(sessionInstance?.close).toHaveBeenCalledTimes(1);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(sessionInstance!.close.mock.invocationCallOrder[0]).toBeLessThan(
        disconnectSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      disconnectSpy.mockRestore();
    }
  }, 15000);

  it('no-config behavior remains unchanged and does not register MCP tools', async () => {
    // We pass an empty configuration file or no --mcp-config flag
    await runChat('hello world', '--format', 'json');

    expect(vi.mocked(AnthropicDirectProvider)).toHaveBeenCalled();
    const firstCallArgs = vi.mocked(AnthropicDirectProvider).mock.calls[0]?.[0];
    expect(firstCallArgs).toBeDefined();

    // Verify no mcp__ tools are present in allowedTools
    const mcpTools = firstCallArgs?.permissions?.allowedTools.filter((t: string) => t.startsWith('mcp__'));
    expect(mcpTools).toEqual([]);

    // Verify no mcpManager is passed
    expect(firstCallArgs?.mcpManager).toBeUndefined();
  }, 15000);
});
