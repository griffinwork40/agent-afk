/**
 * Tests for session-resume flags in `afk chat`:
 *   --resume <id>, --continue, --session-id <uuid>
 *
 * Covers: flag wiring, mutual-exclusion errors, not-found error,
 * session-already-exists error, UUID validation, and persistence on exit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* makeStream(events: OutputEvent[]): AsyncIterable<OutputEvent> {
  for (const event of events) yield event;
}

function makeMockSession() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ content: 'pong', timestamp: new Date() }),
    sendMessageStream: vi.fn().mockReturnValue(makeStream([{ type: 'done' }])),
    getLastResponseMetadata: vi.fn().mockReturnValue(null),
    getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
    sessionId: 'sdk-session-id',
    abortSignal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// Mutable mocks controlled per test
// ---------------------------------------------------------------------------

// These are mutated per test via the `__set*` helpers below.
const mockResolveResumeTarget = vi.fn(() => undefined as ReturnType<typeof import('../resume-session.js')['resolveResumeTarget']>);
const mockResumeConfigFor = vi.fn(() => ({} as Partial<import('../../agent/types.js').AgentConfig>));
const mockSaveSession = vi.fn((_stats: unknown, _id?: string) => '/tmp/mock.json');
const mockFindSession = vi.fn(() => undefined as ReturnType<typeof import('../session-store.js')['findSession']>);
const mockCreateSessionStats = vi.fn(() => ({
  totalTurns: 0,
  totalCostUsd: 0,
  totalTokens: 0,
  totalDurationMs: 0,
  sessionStartTime: Date.now(),
  turnCosts: [] as number[],
  turnTokens: [] as Array<{ input: number; output: number; cache: number }>,
  turns: [] as import('../slash/types.js').TurnRecord[],
  model: 'sonnet' as import('../../agent/types.js').AgentModelInput,
  planMode: false,
}));
const mockRecordTurn = vi.fn(() => ({
  user: '',
  assistant: '',
  timestamp: Date.now(),
  costUsd: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
}));

// ---------------------------------------------------------------------------
// Mocks — hoisted above imports
// ---------------------------------------------------------------------------

vi.mock('../../agent/session.js', () => {
  const MockAgentSession = vi.fn().mockImplementation(makeMockSession);
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
  get resolveResumeTarget() { return mockResolveResumeTarget; },
  get resumeConfigFor() { return mockResumeConfigFor; },
}));

vi.mock('../session-store.js', () => ({
  get saveSession() { return mockSaveSession; },
  get findSession() { return mockFindSession; },
}));

vi.mock('../slash/session-stats.js', () => ({
  get createSessionStats() { return mockCreateSessionStats; },
  get recordTurn() { return mockRecordTurn; },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AgentSession } from '../../agent/session.js';
import { registerChatCommand } from './chat.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function runChat(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerChatCommand(program);
  await program.parseAsync(['node', 'afk', 'chat', ...args]);
}

/** Capture stderr output from fn(). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } catch {
    // swallow — we care about stderr
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk chat — --resume / --continue / --session-id', () => {
  beforeEach(() => {
    vi.mocked(AgentSession).mockClear();
    mockResolveResumeTarget.mockReturnValue(undefined);
    mockResumeConfigFor.mockReturnValue({});
    mockSaveSession.mockReturnValue('/tmp/mock-session.json');
    mockFindSession.mockReturnValue(undefined);
    mockCreateSessionStats.mockReturnValue({
      totalTurns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: Date.now(),
      turnCosts: [],
      turnTokens: [],
      turns: [],
      model: 'sonnet',
      planMode: false,
    });
    mockRecordTurn.mockReturnValue({ user: '', assistant: '', timestamp: Date.now() });
    // Reset stdin to non-TTY so message args work without stdin logic firing.
    // @ts-expect-error
    process.stdin.isTTY = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    // @ts-expect-error
    process.stdin.isTTY = true; // restore to TTY default
  });

  it('errors when --resume and --continue are both set', async () => {
    const stderr = await captureStderr(() =>
      runChat('hello', '--resume', 'abc', '--continue'),
    );
    expect(stderr).toMatch(/mutually exclusive/);
    expect(process.exitCode).toBe(1);
  });

  it('errors when --session-id and --resume are both set', async () => {
    const stderr = await captureStderr(() =>
      runChat('hello', '--session-id', '00000000-0000-0000-0000-000000000001', '--resume', 'abc'),
    );
    expect(stderr).toMatch(/mutually exclusive/);
    expect(process.exitCode).toBe(1);
  });

  it('errors when --session-id and --continue are both set', async () => {
    const stderr = await captureStderr(() =>
      runChat('hello', '--session-id', '00000000-0000-0000-0000-000000000001', '--continue'),
    );
    expect(stderr).toMatch(/mutually exclusive/);
    expect(process.exitCode).toBe(1);
  });

  it('errors when --session-id is not UUID-shaped', async () => {
    const stderr = await captureStderr(() =>
      runChat('hello', '--session-id', 'not-a-uuid'),
    );
    expect(stderr).toMatch(/must be a UUID/);
    expect(process.exitCode).toBe(1);
  });

  it('errors when --session-id already exists', async () => {
    const existingId = '11111111-1111-1111-1111-111111111111';
    mockFindSession.mockReturnValue({
      path: `/tmp/${existingId}.json`,
      id: existingId,
      data: { sessionId: existingId, model: 'sonnet', startedAt: 0, savedAt: 0, totalTurns: 1, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0, turns: [] },
    });

    const stderr = await captureStderr(() =>
      runChat('hello', '--session-id', existingId),
    );
    expect(stderr).toContain('session already exists');
    expect(stderr).toContain('--resume');
    expect(process.exitCode).toBe(1);
  });

  it('errors when --resume id is not found', async () => {
    // resolveResumeTarget returns a shell target without `stored` for unknown ids
    mockResolveResumeTarget.mockReturnValue({ id: 'unknown-id', resumeId: 'unknown-id' });

    const stderr = await captureStderr(() =>
      runChat('hello', '--resume', 'unknown-id', '--format', 'json'),
    );
    expect(stderr).toContain('session not found');
    expect(process.exitCode).toBe(1);
  });

  it('quotes the bad id and includes a recovery hint when --resume is not found', async () => {
    mockResolveResumeTarget.mockReturnValue({ id: 'unknown-id', resumeId: 'unknown-id' });
    const stderr = await captureStderr(() =>
      runChat('hello', '--resume', 'unknown-id', '--format', 'json'),
    );
    // JSON.stringify quotes the id — defends against control bytes in user input.
    expect(stderr).toContain('"unknown-id"');
    // Hint points at the actual recovery path (`/resume` inside `afk i`).
    expect(stderr).toContain('afk i');
    expect(stderr).toContain('/resume');
  });

  it('escapes control bytes in --resume value via JSON.stringify', async () => {
    mockResolveResumeTarget.mockReturnValue({
      id: '\u001b[31m-evil',
      resumeId: '\u001b[31m-evil',
    });
    const stderr = await captureStderr(() =>
      runChat('hello', '--resume', '\u001b[31m-evil', '--format', 'json'),
    );
    // The raw ESC byte must not appear in stderr — it should be the
    // escaped form `\u001b` (visible) instead.
    expect(stderr).not.toContain('\u001b[31m-evil');
    expect(stderr).toContain('\\u001b[31m-evil');
  });

  it('does NOT persist when no session flag is set', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(makeMockSession);

    await runChat('hello', '--format', 'json');

    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('persists session on exit when --resume is set with a found session', async () => {
    const storedSession = {
      sessionId: 'sdk-abc',
      model: 'sonnet' as const,
      startedAt: Date.now() - 1000,
      savedAt: Date.now() - 500,
      totalTurns: 1,
      totalCostUsd: 0.001,
      totalTokens: 100,
      totalDurationMs: 500,
      turns: [{ user: 'hi', assistant: 'hello', timestamp: Date.now() - 800, costUsd: 0.001, durationMs: 500, inputTokens: 50, outputTokens: 50 }],
    };
    mockResolveResumeTarget.mockReturnValue({
      id: 'my-session',
      resumeId: 'sdk-abc',
      stored: storedSession,
    });
    mockResumeConfigFor.mockReturnValue({ resume: 'sdk-abc', sessionId: 'sdk-abc' });
    // createSessionStats returns a stats object; recordTurn increments totalTurns
    const statsObj = {
      totalTurns: 1,  // already has 1 prior turn
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: Date.now(),
      turnCosts: [] as number[],
      turnTokens: [] as Array<{ input: number; output: number; cache: number }>,
      turns: [] as import('../slash/types.js').TurnRecord[],
      model: 'sonnet' as const,
      planMode: false,
    };
    mockCreateSessionStats.mockReturnValue(statsObj);
    // Simulate recordTurn incrementing totalTurns
    mockRecordTurn.mockImplementation(() => {
      statsObj.totalTurns += 1;
      return { user: 'hello', assistant: 'pong', timestamp: Date.now() };
    });

    vi.mocked(AgentSession).mockImplementationOnce(makeMockSession);

    await runChat('hello', '--resume', 'my-session', '--format', 'json');

    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({ totalTurns: expect.any(Number) }),
      'my-session',
    );
  });

  it('persists session on exit when --session-id is set', async () => {
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const statsObj = {
      totalTurns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: Date.now(),
      turnCosts: [] as number[],
      turnTokens: [] as Array<{ input: number; output: number; cache: number }>,
      turns: [] as import('../slash/types.js').TurnRecord[],
      model: 'sonnet' as const,
      planMode: false,
    };
    mockCreateSessionStats.mockReturnValue(statsObj);
    mockRecordTurn.mockImplementation(() => {
      statsObj.totalTurns += 1;
      return { user: 'hello', assistant: 'pong', timestamp: Date.now() };
    });
    vi.mocked(AgentSession).mockImplementationOnce(makeMockSession);

    await runChat('hello', '--session-id', newId, '--format', 'json');

    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({}),
      newId,
    );
  });

  it('prints resume hint to stderr when persisting', async () => {
    const newId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    mockSaveSession.mockReturnValue(`/tmp/${newId}.json`);
    const statsObj = {
      totalTurns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: Date.now(),
      turnCosts: [] as number[],
      turnTokens: [] as Array<{ input: number; output: number; cache: number }>,
      turns: [] as import('../slash/types.js').TurnRecord[],
      model: 'sonnet' as const,
      planMode: false,
    };
    mockCreateSessionStats.mockReturnValue(statsObj);
    mockRecordTurn.mockImplementation(() => {
      statsObj.totalTurns += 1;
      return { user: 'hi', assistant: 'pong', timestamp: Date.now() };
    });
    vi.mocked(AgentSession).mockImplementationOnce(makeMockSession);

    const stderr = await captureStderr(() =>
      runChat('hi', '--session-id', newId, '--format', 'json'),
    );

    expect(stderr).toContain('Continue with: afk chat');
    expect(stderr).toContain('--resume');
  });
});
