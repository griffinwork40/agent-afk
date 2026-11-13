/**
 * Unit tests for `renderTextResponse` and `runStreamJsonPath`
 * (src/cli/commands/chat.response-output.ts).
 *
 * Key invariants pinned here:
 *  - `renderTextResponse`: `spinner.succeed` must be called ONLY after
 *    `session.sendMessage` resolves; on rejection it must NOT print
 *    "Response received" and must re-throw so the caller can surface the error.
 *  - `runStreamJsonPath`: `maybePublish` is called with the accumulated text
 *    and error flag; on an error event the loop exits early.
 *  - Fallback (text mode): when a model-fallback notice fires, it is printed
 *    to stderr exactly once; stdout receives nothing extra; no fallback = no
 *    extra stderr line.
 *  - Fallback (JSON mode): output includes `servedModel` and `modelFallback`;
 *    no fallback = neither field present and output is otherwise unchanged.
 *
 * No real Anthropic API calls are made — AgentSession is fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionStats } from '../slash/types.js';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Shared mock state (mutated per-test in beforeEach)
// ---------------------------------------------------------------------------

let mockSendMessage: ReturnType<typeof vi.fn>;
let mockGetLastResponseMetadata: ReturnType<typeof vi.fn>;
let mockSendMessageStream: ReturnType<typeof vi.fn>;
let mockGetOutputStream: ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('../palette.js', () => ({
  palette: {
    heading: (s: string) => s,
    dim: (s: string) => s,
    error: (s: string) => s,
    info: (s: string) => s,
  },
}));

vi.mock('../format-utils.js', () => ({
  formatDuration: vi.fn(() => '0ms'),
}));

vi.mock('../render/session-summary.js', () => ({
  costTokenParts: vi.fn(() => []),
}));

vi.mock('../formatter.js', () => ({
  renderMarkdownToTerminal: vi.fn((s: string) => s),
}));

vi.mock('./chat.json-output.js', () => ({
  buildOneShotJsonOutput: vi.fn((opts: Record<string, unknown>) => ({
    response: 'mock-json',
    ...(opts['modelFallback'] !== undefined
      ? { servedModel: (opts['modelFallback'] as { to: string }).to, modelFallback: opts['modelFallback'] }
      : {}),
  })),
}));

vi.mock('../slash/session-stats.js', () => ({
  recordTurn: vi.fn(),
}));

vi.mock('../json-date-replacer.js', () => ({
  jsonDateReplacer: vi.fn((_key: string, val: unknown) => val),
}));

vi.mock('./chat.stdin-stream.js', () => ({
  writeAndDrain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./chat.fallback-notice.js', () => ({
  collectFallbackNotice: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { renderTextResponse, runStreamJsonPath } from './chat.response-output.js';
import { collectFallbackNotice } from './chat.fallback-notice.js';
import { buildOneShotJsonOutput } from './chat.json-output.js';
import type {
  TextResponseParams,
  StreamJsonPathParams,
} from './chat.response-output.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    unpricedTurns: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'claude-3-5-sonnet-20241022',
    permissionMode: 'default',
    thinkingUi: 'live',
  } as SessionStats;
}

function makeSpinner() {
  return {
    succeed: vi.fn(),
    fail: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    text: '',
  };
}

function makeSession() {
  return {
    sendMessage: mockSendMessage,
    sendMessageStream: mockSendMessageStream,
    getLastResponseMetadata: mockGetLastResponseMetadata,
    getOutputStream: mockGetOutputStream,
    sessionId: 'test-session-id',
    abortSignal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// renderTextResponse
// ---------------------------------------------------------------------------

describe('renderTextResponse', () => {
  beforeEach(() => {
    mockSendMessage = vi.fn().mockResolvedValue({
      content: 'Hello, world!',
      timestamp: new Date(),
    });
    mockGetLastResponseMetadata = vi.fn().mockReturnValue(null);
    mockGetOutputStream = vi.fn().mockReturnValue((async function* () {})());
    vi.mocked(collectFallbackNotice).mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeParams(overrides: Partial<TextResponseParams> = {}): TextResponseParams {
    return {
      session: makeSession() as unknown as TextResponseParams['session'],
      message: 'hello',
      stats: makeStats(),
      sessionModel: 'claude-3-5-sonnet-20241022',
      format: 'text',
      streamFlag: false,
      receiptSessionLabel: undefined,
      receiptTracePath: undefined,
      maybePublish: vi.fn().mockResolvedValue(undefined),
      spinner: makeSpinner() as unknown as TextResponseParams['spinner'],
      ...overrides,
    };
  }

  it('calls sendMessage with the provided message', async () => {
    const params = makeParams();
    await renderTextResponse(params);
    expect(mockSendMessage).toHaveBeenCalledWith('hello', { stream: false });
  });

  it('calls spinner.succeed("Response received") only after sendMessage resolves', async () => {
    let resolveMessage!: (value: { content: string; timestamp: Date }) => void;
    mockSendMessage = vi.fn().mockReturnValue(
      new Promise<{ content: string; timestamp: Date }>((resolve) => {
        resolveMessage = resolve;
      }),
    );
    // collectFallbackNotice awaits the same promise internally; resolve it here.
    vi.mocked(collectFallbackNotice).mockImplementation(async (_session, work) => {
      await work;
      return undefined;
    });

    const spinner = makeSpinner();
    const params = makeParams({ spinner: spinner as unknown as TextResponseParams['spinner'] });

    const runPromise = renderTextResponse(params);

    // sendMessage has not resolved yet — succeed should NOT have been called
    expect(spinner.succeed).not.toHaveBeenCalled();

    // Now resolve the message
    resolveMessage({ content: 'done', timestamp: new Date() });
    await runPromise;

    expect(spinner.succeed).toHaveBeenCalledWith('Response received');
    expect(spinner.succeed).toHaveBeenCalledOnce();
  });

  it('does NOT call spinner.succeed when sendMessage rejects', async () => {
    mockSendMessage = vi.fn().mockRejectedValue(new Error('provider error'));
    vi.mocked(collectFallbackNotice).mockRejectedValue(new Error('provider error'));
    const spinner = makeSpinner();
    const params = makeParams({ spinner: spinner as unknown as TextResponseParams['spinner'] });

    await expect(renderTextResponse(params)).rejects.toThrow('provider error');

    expect(spinner.succeed).not.toHaveBeenCalled();
  });

  it('does NOT print "Response received" to console when sendMessage rejects', async () => {
    mockSendMessage = vi.fn().mockRejectedValue(new Error('provider error'));
    vi.mocked(collectFallbackNotice).mockRejectedValue(new Error('provider error'));
    const consoleSpy = vi.spyOn(console, 'log');
    const params = makeParams();

    await expect(renderTextResponse(params)).rejects.toThrow();

    const allOutput = consoleSpy.mock.calls.flat().join(' ');
    expect(allOutput).not.toContain('Response received');
  });

  it('re-throws when sendMessage rejects so the caller can surface the error', async () => {
    const original = new Error('provider timeout');
    mockSendMessage = vi.fn().mockRejectedValue(original);
    vi.mocked(collectFallbackNotice).mockRejectedValue(original);
    const params = makeParams();

    const caught = await renderTextResponse(params).catch((e: unknown) => e);
    expect(caught).toBe(original);
  });

  it('calls maybePublish with the response content on success', async () => {
    const maybePublish = vi.fn().mockResolvedValue(undefined);
    const params = makeParams({ maybePublish });
    await renderTextResponse(params);
    expect(maybePublish).toHaveBeenCalledWith('Hello, world!', false);
  });

  it('does not call maybePublish when sendMessage rejects', async () => {
    mockSendMessage = vi.fn().mockRejectedValue(new Error('boom'));
    vi.mocked(collectFallbackNotice).mockRejectedValue(new Error('boom'));
    const maybePublish = vi.fn().mockResolvedValue(undefined);
    const params = makeParams({ maybePublish });

    await expect(renderTextResponse(params)).rejects.toThrow();
    expect(maybePublish).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Fallback notice — text mode
  // ---------------------------------------------------------------------------

  it('text mode: prints notice to stderr exactly once when a fallback fired', async () => {
    const noticeText = 'opus hit its usage limit. Continuing on sonnet.';
    vi.mocked(collectFallbackNotice).mockResolvedValue({
      text: noticeText,
      fallback: { from: 'opus', to: 'sonnet', reason: 'usage_limit' },
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const params = makeParams({ format: 'text' });

    await renderTextResponse(params);

    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const noticeCalls = stderrCalls.filter((s) => s.includes(noticeText));
    expect(noticeCalls).toHaveLength(1);
  });

  it('text mode: nothing extra on stdout when a fallback fired', async () => {
    vi.mocked(collectFallbackNotice).mockResolvedValue({
      text: 'opus hit its limit. Continuing on sonnet.',
      fallback: { from: 'opus', to: 'sonnet', reason: 'usage_limit' },
    });
    const stdoutSpy = vi.spyOn(console, 'log');
    const params = makeParams({ format: 'text' });

    await renderTextResponse(params);

    const stdoutOutput = stdoutSpy.mock.calls.flat().join('\n');
    expect(stdoutOutput).not.toContain('usage_limit');
    expect(stdoutOutput).not.toContain('modelFallback');
  });

  it('text mode: nothing written to stderr when no fallback fired', async () => {
    vi.mocked(collectFallbackNotice).mockResolvedValue(undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const params = makeParams({ format: 'text' });

    await renderTextResponse(params);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Fallback notice — JSON mode
  // ---------------------------------------------------------------------------

  it('JSON mode: output includes servedModel and modelFallback when fallback fired', async () => {
    const fallback = { from: 'opus', to: 'sonnet', reason: 'usage_limit' };
    vi.mocked(collectFallbackNotice).mockResolvedValue({
      text: 'opus hit its limit.',
      fallback,
    });
    const consoleSpy = vi.spyOn(console, 'log');
    const params = makeParams({ format: 'json' });

    await renderTextResponse(params);

    // buildOneShotJsonOutput was called with modelFallback
    expect(vi.mocked(buildOneShotJsonOutput)).toHaveBeenCalledWith(
      expect.objectContaining({ modelFallback: fallback }),
    );
    // The printed JSON (from our mock) includes the fallback fields
    const printed = consoleSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('sonnet');
    expect(printed).toContain('modelFallback');
  });

  it('JSON mode: modelFallback field absent and output unchanged when no fallback fired', async () => {
    vi.mocked(collectFallbackNotice).mockResolvedValue(undefined);
    const params = makeParams({ format: 'json' });

    await renderTextResponse(params);

    expect(vi.mocked(buildOneShotJsonOutput)).toHaveBeenCalledWith(
      expect.objectContaining({ modelFallback: undefined }),
    );
  });
});

// ---------------------------------------------------------------------------
// runStreamJsonPath
// ---------------------------------------------------------------------------

async function* makeStream(events: OutputEvent[]): AsyncIterable<OutputEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('runStreamJsonPath', () => {
  beforeEach(() => {
    mockSendMessageStream = vi.fn().mockReturnValue(makeStream([]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeParams(overrides: Partial<StreamJsonPathParams> = {}): StreamJsonPathParams {
    return {
      session: makeSession() as unknown as StreamJsonPathParams['session'],
      message: 'stream me',
      stats: makeStats(),
      maybePublish: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('calls maybePublish with accumulated text and errored=false on clean stream', async () => {
    mockSendMessageStream = vi.fn().mockReturnValue(
      makeStream([
        { type: 'chunk', chunk: { type: 'content', content: 'Hello ' } },
        { type: 'chunk', chunk: { type: 'content', content: 'world' } },
        { type: 'done', metadata: undefined },
      ] satisfies OutputEvent[]),
    );
    const maybePublish = vi.fn().mockResolvedValue(undefined);
    const params = makeParams({ maybePublish });

    await runStreamJsonPath(params);

    expect(maybePublish).toHaveBeenCalledWith('Hello world', false);
  });

  it('calls maybePublish with errored=true on error event', async () => {
    mockSendMessageStream = vi.fn().mockReturnValue(
      makeStream([
        { type: 'chunk', chunk: { type: 'content', content: 'partial' } },
        { type: 'error', error: new Error('stream failure') },
      ] satisfies OutputEvent[]),
    );
    const maybePublish = vi.fn().mockResolvedValue(undefined);
    const params = makeParams({ maybePublish });

    await runStreamJsonPath(params);

    expect(maybePublish).toHaveBeenCalledWith('partial', true);
  });

  it('exits the event loop after an error event (does not process further events)', async () => {
    const afterError = { type: 'done', metadata: undefined } satisfies OutputEvent;
    mockSendMessageStream = vi.fn().mockReturnValue(
      makeStream([
        { type: 'error', error: new Error('early failure') },
        afterError,
      ] satisfies OutputEvent[]),
    );

    const { writeAndDrain: mockWrite } = await import('./chat.stdin-stream.js');
    const writeSpy = vi.mocked(mockWrite);
    writeSpy.mockClear();

    const params = makeParams();
    await runStreamJsonPath(params);

    // Only the error event should have been written, not the subsequent done event
    const calls = writeSpy.mock.calls;
    const writtenBodies = calls.map((c) => JSON.parse(c[1] as string) as { type: string });
    const types = writtenBodies.map((b) => b.type);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });

  it('sets process.exitCode to 1 on error event', async () => {
    mockSendMessageStream = vi.fn().mockReturnValue(
      makeStream([{ type: 'error', error: new Error('oops') }] satisfies OutputEvent[]),
    );
    const params = makeParams();

    const originalExitCode = process.exitCode;
    await runStreamJsonPath(params);
    const finalExitCode = process.exitCode;
    process.exitCode = originalExitCode; // restore

    expect(finalExitCode).toBe(1);
  });
});
