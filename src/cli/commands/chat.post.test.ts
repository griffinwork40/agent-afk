/**
 * Tests for `afk chat --post <targets>` / `--post-pr <ref>` headless publishing.
 *
 * The publish stack (`runReviewPostPublish`) is mocked at the module boundary so
 * these tests assert *invocation* — that the flag is parsed and the publisher is
 * called with the right `targets` / `reviewText` / `prRefFromArgs` — not that the
 * underlying gh/Telegram calls fire (those are covered by review-post.test.ts).
 * The real `parsePostFlag` runs (via importOriginal) so target validation is
 * exercised end-to-end.
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

/** A fresh AgentSession mock implementation whose text turn returns `content`. */
function sessionImpl(content: string) {
  return () => ({
    close: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ content, timestamp: new Date() }),
    sendMessageStream: vi.fn().mockReturnValue(makeStream([{ type: 'done' }])),
    getLastResponseMetadata: vi.fn().mockReturnValue(null),
    getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
    sessionId: 'mock-session-id',
    abortSignal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------
// Mocks — hoisted above module imports.
// ---------------------------------------------------------------------------

vi.mock('../../agent/session.js', () => ({
  AgentSession: vi.fn().mockImplementation(sessionImpl('pong')),
}));

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

// Partial mock: keep the REAL parsePostFlag (so target validation is exercised),
// replace only the side-effecting publisher with a spy.
vi.mock('../slash/_lib/review-post.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../slash/_lib/review-post.js')>();
  return {
    ...real,
    runReviewPostPublish: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AgentSession } from '../../agent/session.js';
import { runReviewPostPublish } from '../slash/_lib/review-post.js';
import { registerChatCommand } from './chat.js';

const mockPublish = vi.mocked(runReviewPostPublish);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runChat(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerChatCommand(program);
  await program.parseAsync(['node', 'afk', 'chat', ...args]);
}

/** Capture stderr written during fn(). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } catch {
    /* ignore — we only want stderr */
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

/** Swallow stdout writes (and fire the write callback) so NDJSON paths don't hang. */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      chunks.push(String(chunk));
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') {
        setImmediate(() => (callback as (err?: Error | null) => void)(null));
      }
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('').split('\n').filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk chat — --post headless publishing', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.mocked(AgentSession).mockReset();
    vi.mocked(AgentSession).mockImplementation(sessionImpl('pong'));
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
    // Positional-message path: a literal arg is used regardless of TTY, but force
    // non-TTY so an accidentally-omitted arg fails loudly instead of reading stdin.
    // @ts-expect-error — overriding readonly-ish runtime prop for the test
    process.stdin.isTTY = false;
    process.exitCode = undefined;
  });

  afterEach(() => {
    // @ts-expect-error — restore original
    process.stdin.isTTY = originalIsTTY;
    process.exitCode = undefined;
  });

  it('does not publish when --post is absent', async () => {
    await runChat('hello', '--format', 'json');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('--post github calls the publisher with targets ["github"]', async () => {
    await runChat('hello', '--post', 'github', '--format', 'json');
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targets: ['github'] }),
    );
  });

  it('--post telegram calls the publisher with targets ["telegram"]', async () => {
    await runChat('hello', '--post', 'telegram', '--format', 'json');
    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targets: ['telegram'] }),
    );
  });

  it('--post github,telegram calls the publisher with both targets', async () => {
    await runChat('hello', '--post', 'github,telegram', '--format', 'json');
    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targets: ['github', 'telegram'] }),
    );
  });

  it('--post with an unknown target warns and does not publish (exit not 1)', async () => {
    const stderr = await captureStderr(() => runChat('hello', '--post', 'slack', '--format', 'json'));
    expect(stderr).toMatch(/unknown --post target ignored: slack/);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
  });

  it('--post-pr forwards the ref as prRefFromArgs', async () => {
    await runChat('hello', '--post', 'github', '--post-pr', '123', '--format', 'json');
    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prRefFromArgs: '123' }),
    );
  });

  it('prRefFromArgs is null when --post-pr is omitted', async () => {
    await runChat('hello', '--post', 'github', '--format', 'json');
    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prRefFromArgs: null }),
    );
  });

  it('passes the final assistant text as reviewText (text path)', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(sessionImpl('the full review output'));
    await runChat('review it', '--post', 'github', '--format', 'json');
    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reviewText: 'the full review output' }),
    );
  });

  it('publishes the accumulated text on the stream-json path', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => ({
      close: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ content: 'unused', timestamp: new Date() }),
      sendMessageStream: vi.fn().mockReturnValue(
        makeStream([
          { type: 'chunk', chunk: { type: 'content', content: 'streamed ' } },
          { type: 'chunk', chunk: { type: 'content', content: 'output' } },
          { type: 'done', metadata: undefined },
        ] as OutputEvent[]),
      ),
      getLastResponseMetadata: vi.fn().mockReturnValue(null),
      getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
      sessionId: 'mock-session-id',
      abortSignal: new AbortController().signal,
    }));

    await captureStdout(() => runChat('review it', '--format', 'stream-json', '--post', 'github'));

    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targets: ['github'], reviewText: 'streamed output' }),
    );
  });

  it('is fail-soft: a throwing publisher does not flip the exit code', async () => {
    mockPublish.mockReset();
    mockPublish.mockRejectedValueOnce(new Error('post failed'));
    const stderr = await captureStderr(() => runChat('hello', '--post', 'github', '--format', 'json'));
    expect(stderr).toMatch(/\[--post\] publish failed: post failed/);
    expect(process.exitCode).not.toBe(1);
  });
});
