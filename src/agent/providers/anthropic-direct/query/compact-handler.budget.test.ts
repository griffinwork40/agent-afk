/**
 * Summarizer input budget wiring for the Anthropic compaction handler.
 *
 * When AFK_COMPACT_MODEL routes the summary to a `chatgpt-oauth` OpenAI
 * connection, the budget must use the subscription window; otherwise it uses
 * the API-tier window of the resolved summarizer model. `contextLimitFor`,
 * slot bindings, and OpenAI auth are stubbed, so no local catalog, config, or
 * credential is read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

const runCompactionCoreMock = vi.hoisted(() => vi.fn());
const contextLimitForMock = vi.hoisted(() => vi.fn());
const SUB_WINDOW = 100_000;
const API_WINDOW = 400_000;

vi.mock('../../../model-limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../model-limits.js')>()),
  contextLimitFor: contextLimitForMock,
}));

vi.mock('../../shared/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/compaction.js')>()),
  runCompactionCore: runCompactionCoreMock,
}));

vi.mock('../../../session/model-slots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session/model-slots.js')>()),
  resolveBinding: (input: string | undefined) =>
    input === 'sub-slot' ? { id: 'gpt-6-luna', provider: 'chatgpt-oauth' } : { id: input ?? '' },
}));

vi.mock('../../openai-compatible/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../openai-compatible/auth.js')>()),
  resolveOpenAIAuth: (_key: string | undefined, _deps: unknown, force?: boolean) =>
    force
      ? { apiKey: 'oauth-token', source: 'chatgpt-oauth', accountId: 'acct' }
      : { apiKey: 'sk-test', source: 'env' },
}));

import { compactHistory } from './compact-handler.js';
import { createSessionState } from './session-state.js';
import { AbortCoordinator } from '../../shared/abort-coordinator.js';
import type { RetryLayer } from './retry-layer.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';

const budget = (window: number): number => Math.floor(window * 0.5 * 3);

function makeState() {
  const messages: MessageParam[] = [{ role: 'user', content: 'hello' }];
  return createSessionState({
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    userSystem: null,
    toolDispatcher: {} as unknown as ToolDispatcher,
    initialMessages: messages,
  });
}

async function capturedBudget(): Promise<unknown> {
  await compactHistory({
    state: makeState(),
    abort: new AbortCoordinator(),
    retry: { authMode: 'oauth' } as unknown as RetryLayer,
    initSessionId: 's1',
  });
  return (runCompactionCoreMock.mock.calls[0]?.[0] as { summarizerInputMaxChars?: number }).summarizerInputMaxChars;
}

beforeEach(() => {
  runCompactionCoreMock.mockReset();
  runCompactionCoreMock.mockResolvedValue({ compacted: false, reason: 'history-too-short', messagesBefore: 1, messagesAfter: 1 });
  contextLimitForMock.mockReset();
  contextLimitForMock.mockImplementation((_model: string, subscriptionPath = false) => (subscriptionPath ? SUB_WINDOW : API_WINDOW));
  vi.stubEnv('AFK_COMPACT_MODEL', undefined);
  vi.stubEnv('AFK_PROVIDER', undefined);
  vi.stubEnv('AFK_OPENAI_BASE_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compactHistory summarizer input budget', () => {
  it('compact model routed to a chatgpt-oauth binding uses the subscription window of that model', async () => {
    vi.stubEnv('AFK_COMPACT_MODEL', 'sub-slot');
    expect(await capturedBudget()).toBe(budget(SUB_WINDOW));
    expect(contextLimitForMock).toHaveBeenCalledWith('gpt-6-luna', true);
  });

  it('compact model routed to an OpenAI API key uses the API-tier window', async () => {
    vi.stubEnv('AFK_COMPACT_MODEL', 'gpt-6-luna');
    expect(await capturedBudget()).toBe(budget(API_WINDOW));
    expect(contextLimitForMock).toHaveBeenCalledWith('gpt-6-luna', false);
  });

  it('no compact model uses the default Anthropic summarizer on the API-tier window', async () => {
    expect(await capturedBudget()).toBe(budget(API_WINDOW));
    expect(contextLimitForMock).toHaveBeenCalledWith('claude-haiku-4-5-20251001', false);
  });
});
