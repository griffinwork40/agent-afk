/**
 * Summarizer input budget wiring for the OpenAI-compatible compaction handler.
 *
 * The budget must use the window of the connection that actually sends the
 * summary. `contextLimitFor` is stubbed to return a small window on the
 * subscription catalog and a large one on the API-tier table, so these tests
 * never read the local Codex catalog or real credentials.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';

const compactOpenAIHistoryMock = vi.hoisted(() => vi.fn());
const SUB_WINDOW = 100_000;
const API_WINDOW = 400_000;

vi.mock('../../../model-limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../model-limits.js')>()),
  contextLimitFor: (_model: string, subscriptionPath = false) => (subscriptionPath ? SUB_WINDOW : API_WINDOW),
}));

vi.mock('../compact.js', () => ({
  compactOpenAIHistory: compactOpenAIHistoryMock,
  readShrinkFraction: () => 0.5,
}));

vi.mock('../../../session/model-slots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session/model-slots.js')>()),
  resolveBinding: (input: string | undefined) => ({ id: input ?? '' }),
}));

import { runCompactHistory, type CompactHandlerContext } from './compact-handler.js';
import { AbortCoordinator } from '../../shared/abort-coordinator.js';
import type { OpenAIJournalWiring } from './journal-wiring.js';

/** Budget for a window: half the window, three characters per token. */
const budget = (window: number): number => Math.floor(window * 0.5 * 3);

function makeCtx(source: string, baseURL?: string): CompactHandlerContext {
  return {
    client: {} as OpenAI,
    wireMode: source === 'chatgpt-oauth' ? 'responses' : 'chat-completions',
    abort: new AbortCoordinator(),
    priorTurns: [],
    journal: { afterCompact: vi.fn(), microcompactFallback: vi.fn() } as unknown as OpenAIJournalWiring,
    traceWriter: undefined,
    opts: { auth: { apiKey: 'token', source }, config: {}, ...(baseURL ? { baseURL } : {}) },
    currentModel: 'gpt-5.5',
    closed: false,
    lastUsage: null,
    responsesCompactionUnavailable: false,
    markResponsesCompactionUnavailable: vi.fn(),
  };
}

async function capturedBudget(ctx: CompactHandlerContext): Promise<unknown> {
  await runCompactHistory(ctx, 'manual');
  return (compactOpenAIHistoryMock.mock.calls[0]?.[0] as { summarizerInputMaxChars?: number }).summarizerInputMaxChars;
}

beforeEach(() => {
  compactOpenAIHistoryMock.mockReset();
  compactOpenAIHistoryMock.mockResolvedValue({ compacted: false, reason: 'history-too-short', messagesBefore: 0, messagesAfter: 0 });
  vi.stubEnv('AFK_COMPACT_MODEL', undefined);
  vi.stubEnv('AFK_PROVIDER', undefined);
  vi.stubEnv('AFK_OPENAI_BASE_URL', undefined);
  vi.stubEnv('OPENAI_BASE_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runCompactHistory summarizer input budget', () => {
  it('chatgpt-oauth session without AFK_COMPACT_MODEL uses the subscription window', async () => {
    expect(await capturedBudget(makeCtx('chatgpt-oauth'))).toBe(budget(SUB_WINDOW));
  });

  it('chatgpt-oauth session with a same-family AFK_COMPACT_MODEL still uses the subscription window', async () => {
    vi.stubEnv('AFK_COMPACT_MODEL', 'gpt-6-luna');
    expect(await capturedBudget(makeCtx('chatgpt-oauth'))).toBe(budget(SUB_WINDOW));
  });

  it('chatgpt-oauth session with a foreign (Anthropic) AFK_COMPACT_MODEL uses the API-tier window', async () => {
    vi.stubEnv('AFK_COMPACT_MODEL', 'claude-haiku-4-5-20251001');
    expect(await capturedBudget(makeCtx('chatgpt-oauth'))).toBe(budget(API_WINDOW));
  });

  it('API-key session uses the API-tier window with or without AFK_COMPACT_MODEL', async () => {
    expect(await capturedBudget(makeCtx('env'))).toBe(budget(API_WINDOW));
    compactOpenAIHistoryMock.mockClear();
    vi.stubEnv('AFK_COMPACT_MODEL', 'gpt-6-luna');
    expect(await capturedBudget(makeCtx('env'))).toBe(budget(API_WINDOW));
  });
});
