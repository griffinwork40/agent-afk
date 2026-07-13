/**
 * Tests for stdin input resolution in `afk chat`.
 *
 * Covers: `-` sentinel, pipe-auto-detect (omitted arg + piped stdin),
 * literal arg pass-through, and TTY-stdin error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* makeStream(events: OutputEvent[]): AsyncIterable<OutputEvent> {
  for (const event of events) {
    yield event;
  }
}

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above module imports.
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

vi.mock('../../agent/mcp/index.js', () => ({
  McpManager: {
    fromConfig: vi.fn(),
  },
  loadMcpConfig: vi.fn(() => ({ mcpServers: {}, sources: [], warnings: [] })),
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
  // The (unmocked) openai-compatible provider imports these from memory/index.js
  // at module load; empty/no-op stubs keep the mocked memory tool universe empty.
  memoryToolSchemas: [],
  memorySearchTool: { name: 'memory_search', input_schema: { type: 'object' as const } },
  createMemoryHandlers: () => new Map(),
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

vi.mock('../../agent/tools/nesting.js', () => ({
  createChildProviderFactory: vi.fn(() => ({})),
  createChildSkillExecutorFactory: vi.fn(() => ({})),
}));

vi.mock('../../agent/providers/anthropic-direct/index.js', () => ({
  AnthropicDirectProvider: vi.fn().mockImplementation(() => ({})),
}));

// The dispatcher (pulled in transitively via the anthropic-direct provider)
// imports builtinToolSchemas/agentTool/skillTool/composeTool from here to build
// its concurrency-safe tool set. These tests don't assert on the tool universe,
// so stub each with the minimum AnthropicToolDef shape the dispatcher reads
// (name + input_schema); omitting concurrencySafe keeps the safe-tool set empty,
// matching BUILTIN_TOOL_NAMES: []. Objects are inlined because vi.mock factories
// are hoisted above module-scope declarations.
vi.mock('../../agent/tools/schemas.js', () => ({
  BUILTIN_TOOL_NAMES: [],
  builtinToolSchemas: [],
  agentTool: { name: 'agent', input_schema: { type: 'object' as const } },
  skillTool: { name: 'skill', input_schema: { type: 'object' as const } },
  composeTool: { name: 'compose', input_schema: { type: 'object' as const } },
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AgentSession } from '../../agent/session.js';
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

/** Capture stderr lines written during fn(). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } catch {
    // ignore — we just want stderr
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk chat — stdin input', () => {
  beforeEach(() => {
    vi.mocked(AgentSession).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset process.exitCode after each test.
    process.exitCode = undefined;
  });

  it('passes a literal positional message directly', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => ({
      close: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ content: 'pong', timestamp: new Date() }),
      sendMessageStream: vi.fn().mockReturnValue(makeStream([{ type: 'done' }])),
      getLastResponseMetadata: vi.fn().mockReturnValue(null),
      getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
      sessionId: 'mock-session-id',
      abortSignal: new AbortController().signal,
    }));

    await runChat('hello world', '--format', 'json');

    const instance = vi.mocked(AgentSession).mock.results[0]?.value as
      { sendMessage: ReturnType<typeof vi.fn> } | undefined;
    expect(instance?.sendMessage).toHaveBeenCalledWith('hello world', expect.anything());
  });

  it('reads from stdin when arg is `-` and stdin is a pipe', async () => {
    // Simulate a piped stdin stream.
    const originalIsTTY = process.stdin.isTTY;
    // @ts-expect-error — forcing non-TTY for test
    process.stdin.isTTY = false;

    let stdinData = '';
    vi.mocked(AgentSession).mockImplementationOnce(() => ({
      close: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockImplementation((msg: string) => {
        stdinData = msg;
        return Promise.resolve({ content: 'ok', timestamp: new Date() });
      }),
      sendMessageStream: vi.fn().mockReturnValue(makeStream([{ type: 'done' }])),
      getLastResponseMetadata: vi.fn().mockReturnValue(null),
      getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
      sessionId: 'mock-session-id',
      abortSignal: new AbortController().signal,
    }));

    // Stub process.stdin to emit "piped content\n" then end.
    const { Readable } = await import('node:stream');
    const mockStdin = new Readable({ read() {} });
    const originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

    const runPromise = runChat('-', '--format', 'json');
    mockStdin.push('piped content\n');
    mockStdin.push(null); // EOF
    await runPromise;

    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    // @ts-expect-error
    process.stdin.isTTY = originalIsTTY;

    expect(stdinData).toBe('piped content');
  });

  it('errors when `-` is used and stdin is a TTY', async () => {
    const originalIsTTY = process.stdin.isTTY;
    // @ts-expect-error
    process.stdin.isTTY = true;

    const stderr = await captureStderr(() => runChat('-', '--format', 'json'));

    // @ts-expect-error
    process.stdin.isTTY = originalIsTTY;

    expect(stderr).toContain('no stdin available');
    expect(process.exitCode).toBe(1);
  });

  it('errors when no message is supplied and stdin is a TTY', async () => {
    const originalIsTTY = process.stdin.isTTY;
    // @ts-expect-error
    process.stdin.isTTY = true;

    const stderr = await captureStderr(() => runChat('--format', 'json'));

    // @ts-expect-error
    process.stdin.isTTY = originalIsTTY;

    expect(stderr).toMatch(/missing message/);
    expect(process.exitCode).toBe(1);
  });

  // Regression: readStdin used to hang forever when stdin had already reached
  // EOF before the call (process.stdin.readableEnded === true). The fix
  // resolves with '' synchronously; the empty-message guard then exits 1.
  it('exits cleanly when stdin reached EOF before the handler ran', async () => {
    const originalIsTTY = process.stdin.isTTY;
    // @ts-expect-error
    process.stdin.isTTY = false;

    const { Readable } = await import('node:stream');
    const endedStdin = new Readable({ read() {} });
    endedStdin.push(null); // EOF immediately
    // Wait one tick so the stream transitions to readableEnded=true.
    await new Promise<void>((r) => setImmediate(r));

    const originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: endedStdin, configurable: true });

    // Tight timeout to fail loudly if the regression returns and readStdin hangs.
    const stderr = await Promise.race([
      captureStderr(() => runChat('-', '--format', 'json')),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('readStdin hung')), 2000)),
    ]);

    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    // @ts-expect-error
    process.stdin.isTTY = originalIsTTY;

    expect(stderr).toMatch(/message is empty/);
    expect(process.exitCode).toBe(1);
  });
});
