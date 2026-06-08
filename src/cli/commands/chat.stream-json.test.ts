/**
 * Tests for `afk chat --format stream-json`.
 *
 * Mocks AgentSession so no real Anthropic API call is made. The stream-json
 * path calls `session.sendMessageStream` and writes NDJSON to stdout; this
 * test captures process.stdout.write to verify the wire shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers — build a fake OutputEvent async generator
// ---------------------------------------------------------------------------

async function* makeStream(events: OutputEvent[]): AsyncIterable<OutputEvent> {
  for (const event of events) {
    yield event;
  }
}

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports of the modules they replace.
// IMPORTANT: vi.mock factories cannot reference variables declared in this
// module scope (they are hoisted above all statements). Any shared state
// must be set via the exported mock's properties after import.
// ---------------------------------------------------------------------------

vi.mock('../../agent/session.js', () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue({ content: 'hi', timestamp: new Date() });
  const sendMessageStream = vi.fn();
  const getLastResponseMetadata = vi.fn().mockReturnValue(null);
  const getInputStreamRef = vi.fn().mockReturnValue({ pushUserMessage: vi.fn() });

  const MockAgentSession = vi.fn().mockImplementation(() => ({
    close,
    sendMessage,
    sendMessageStream,
    getLastResponseMetadata,
    getInputStreamRef,
    sessionId: 'mock-session-id',
    abortSignal: new AbortController().signal,
  }));

  return { AgentSession: MockAgentSession };
});

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    model: 'sonnet',
    maxTokens: 4096,
    temperature: 1.0,
    updatePolicy: 'notify',
  })),
}));

vi.mock('../shared-helpers.js', () => ({
  parseThinking: vi.fn(() => undefined),
  parseEffort: vi.fn(() => undefined),
  parseBudget: vi.fn(() => undefined),
  parseMaxOutputTokens: vi.fn(() => undefined),
  parseProvider: vi.fn(() => undefined),
  getApiKey: vi.fn(() => 'test-api-key'),
  getApiKeyForModel: vi.fn(() => 'test-api-key'),
  getModel: vi.fn(() => 'sonnet'),
  getThinking: vi.fn(() => undefined),
  getEffort: vi.fn(() => undefined),
  getMaxBudgetUsd: vi.fn(() => undefined),
  getTaskBudget: vi.fn(() => undefined),
  getMaxOutputTokens: vi.fn(() => undefined),
  getDefaultSubagentModel: vi.fn(() => 'sonnet'),
  loadSystemPrompt: vi.fn(() => undefined),
  loadConfigSystemPrompt: vi.fn(() => undefined),
  resolveBaseSystemPrompt: vi.fn(() => ({ prompt: undefined, source: 'none' })),
}));

vi.mock('../../agent/routing-directive.js', () => ({
  assembleSystemPrompt: vi.fn(
    (_base: unknown, _routing: unknown, _surface: unknown) => undefined,
  ),
}));

vi.mock('../../agent/default-hook-registry.js', () => ({
  createDefaultHookRegistry: vi.fn(() => ({ registry: {} })),
}));

vi.mock('../../agent/memory/index.js', () => {
  const close = vi.fn();
  return {
    MemoryStore: vi.fn(() => ({ close })),
    injectHotMemory: (config: unknown) => config,
    MEMORY_TOOL_NAMES: [],
  };
});

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

// ---------------------------------------------------------------------------
// Import after mocks are established
// ---------------------------------------------------------------------------

import { AgentSession } from '../../agent/session.js';
import { registerChatCommand } from './chat.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Return the `sendMessageStream` mock from the most recently constructed
 * AgentSession instance. Must be called after the session has been created.
 */
function getStreamMock(): ReturnType<typeof vi.fn> {
  const instance = vi.mocked(AgentSession).mock.results[0]?.value as
    | { sendMessageStream: ReturnType<typeof vi.fn> }
    | undefined;
  if (!instance) throw new Error('No AgentSession instance found');
  return instance.sendMessageStream;
}

/**
 * Pre-configure the stream that the next AgentSession instance will return
 * from `sendMessageStream`. Because all instances share the same mock function
 * reference (created once in the factory closure), we look it up from the
 * constructor mock after running the command once with a no-op stream first,
 * but that is awkward. Instead we use a simpler approach: configure the return
 * value on the constructor mock so the returned instance carries it.
 */
function configureStream(events: OutputEvent[]): void {
  vi.mocked(AgentSession).mockImplementationOnce(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ content: 'hi', timestamp: new Date() }),
    sendMessageStream: vi.fn().mockReturnValue(makeStream(events)),
    getLastResponseMetadata: vi.fn().mockReturnValue(null),
    getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
    sessionId: 'mock-session-id',
    abortSignal: new AbortController().signal,
  }));
}

/** Capture stdout writes during `fn()`, return non-empty lines.
 *
 * Honours Node's stream.write(chunk, callback) contract — the callback must
 * be invoked even on the synchronous fast path. Without this, writeAndDrain's
 * callback-exclusive settlement (PR #447 H1 fix) waits forever. */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      chunks.push(String(chunk));
      // stream.write supports both (chunk, callback) and (chunk, encoding, callback).
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') {
        // Fire asynchronously to match Node's real behaviour.
        setImmediate(() => (callback as (err?: Error | null) => void)(null));
      }
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks
    .join('')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

/** Build and run the chat command with given args. */
async function runChat(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerChatCommand(program);
  await program.parseAsync(['node', 'afk', 'chat', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk chat --format stream-json', () => {
  beforeEach(() => {
    // Clear call history only — do not reset factory-level implementations.
    vi.mocked(AgentSession).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits each OutputEvent as a separate NDJSON line', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'Hello ' } },
      { type: 'chunk', chunk: { type: 'content', content: 'world' } },
      { type: 'message', message: { content: 'Hello world', timestamp: new Date('2024-01-01T00:00:00.000Z') } },
      { type: 'done', metadata: undefined },
    ];
    configureStream(events);

    const lines = await captureStdout(() => runChat('say hi', '--format', 'stream-json'));

    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('every line is valid JSON', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hi' } },
      { type: 'done' },
    ];
    configureStream(events);

    const lines = await captureStdout(() => runChat('say hi', '--format', 'stream-json'));

    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toBeTruthy();
    }
  });

  it('at least one event has type chunk or message', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hi' } },
      { type: 'done' },
    ];
    configureStream(events);

    const lines = await captureStdout(() => runChat('say hi', '--format', 'stream-json'));

    const parsed = lines.map((l) => JSON.parse(l) as { type: string });
    const types = parsed.map((e) => e.type);
    expect(types.some((t) => t === 'chunk' || t === 'message')).toBe(true);
  });

  it('final event has type done', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hi' } },
      { type: 'done' },
    ];
    configureStream(events);

    const lines = await captureStdout(() => runChat('say hi', '--format', 'stream-json'));

    const last = lines[lines.length - 1];
    expect(last).toBeDefined();
    const parsed = JSON.parse(last!) as { type: string };
    expect(parsed.type).toBe('done');
  });

  it('serializes Date fields (paused.resetsAt) as ISO strings not {}', async () => {
    const resetDate = new Date('2024-06-01T12:00:00.000Z');
    const events: OutputEvent[] = [
      { type: 'paused', reason: 'usage-limit', resetsAt: resetDate },
      { type: 'done' },
    ];
    configureStream(events);

    const lines = await captureStdout(() => runChat('say hi', '--format', 'stream-json'));

    const pausedLine = lines.find((l) => l.includes('"paused"'));
    expect(pausedLine).toBeDefined();
    const parsed = JSON.parse(pausedLine!) as { type: string; resetsAt: string };
    expect(parsed.resetsAt).toBe('2024-06-01T12:00:00.000Z');
  });

  it('emits error event as final NDJSON line and sets exit code 1', async () => {
    const err = new Error('provider failure');
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'partial' } },
      { type: 'error', error: err },
    ];
    configureStream(events);

    const originalExitCode = process.exitCode;
    const lines = await captureStdout(() => runChat('say hi', '--format', 'stream-json'));
    const finalExitCode = process.exitCode;
    // Restore so other tests are not affected
    process.exitCode = originalExitCode;

    const errorLine = lines.find((l) => l.includes('"error"'));
    expect(errorLine).toBeDefined();
    const parsed = JSON.parse(errorLine!) as { type: string; error: { message: string; name: string } };
    expect(parsed.type).toBe('error');
    // Error objects must serialize with message/name — not as {}. Stack is
    // deliberately omitted because V8 stack traces embed absolute filesystem
    // paths and would leak host-machine layout to headless NDJSON consumers.
    expect(parsed.error.message).toBe('provider failure');
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error).not.toHaveProperty('stack');
    expect(finalExitCode).toBe(1);
  });

  it('does not call sendMessage for stream-json format', async () => {
    const events: OutputEvent[] = [{ type: 'done' }];
    configureStream(events);

    await captureStdout(() => runChat('say hi', '--format', 'stream-json'));

    // The instance's sendMessage should not have been called
    const instance = vi.mocked(AgentSession).mock.results[0]?.value as {
      sendMessage: ReturnType<typeof vi.fn>;
      sendMessageStream: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(instance?.sendMessageStream).toHaveBeenCalledOnce();
    expect(instance?.sendMessage).not.toHaveBeenCalled();
  });
});
