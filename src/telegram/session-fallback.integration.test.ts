/** Real Telegram factory + AgentSession + providers, with only SDK/infra faked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'telegraf';
import type { AgentConfig } from '../agent/types.js';
import type { MemoryStore } from '../agent/memory/index.js';
import type { TelegramBotConfig } from './session-context.js';

const fallback = vi.hoisted(() => ({ model: undefined as string | undefined }));
vi.mock('../cli/config/json-tier.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadJsonConfig: () => ({
    config: fallback.model ? { fallbackModel: fallback.model } : {},
    modelsPartial: {}, sourcePath: undefined,
  }),
}));
vi.mock('./mcp-session.js', () => ({
  loadTelegramMcpManager: async () => undefined,
  attachMcpCleanup: (session: unknown) => session,
}));
vi.mock('./afk-hook-bundle.js', () => ({
  createTelegramAfkHookBundle: () => ({ registry: undefined }),
}));
vi.mock('./wire-telegram-executors.js', () => ({
  wireTelegramExecutors: () => ({ executors: {}, bindSession: () => {} }),
}));
vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { createTelegramSessionFactory } from './create-session.js';
import { streamResponse } from './streaming.js';
import { useTmpAfkHome } from '../agent/journal/__test-utils__/helpers.js';
import { resetSlotBindings } from '../agent/session/model-slots.js';
import { routesInjectedProviderForFallback } from '../agent/session/fallback-model.js';
import {
  installWire, uninstallWire, usageLimit429, modelNotFound404,
  anthropicText, openaiText, runTurn, fallbackNotices, streamedText,
} from '../agent/session/__test-utils__/model-fallback-wire.js';

useTmpAfkHome();
const PRIMARY = 'claude-sonnet-4-6';
const SAME_FAMILY = 'claude-haiku-5-5';
const OPENAI = 'gpt-4o';
const CHAT = -100123;
const THREAD = 42;

function createSession(model = PRIMARY) {
  return createTelegramSessionFactory({
    config: {} as TelegramBotConfig, frameworkBase: undefined, telegramCwd: undefined,
    memoryStore: {} as MemoryStore, log: () => {},
  })({ model, apiKey: 'sk-ant-test', telegramChatId: CHAT, telegramThreadId: THREAD });
}

beforeEach(() => {
  resetSlotBindings();
  vi.stubEnv('AFK_TRACE_DISABLED', '1');
  vi.stubEnv('AFK_WORKSPACE_DISABLED', '1');
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  fallback.model = SAME_FAMILY;
});
afterEach(() => { uninstallWire(); resetSlotBindings(); vi.unstubAllEnvs(); });

describe('Telegram configured model fallback', () => {
  it.each([SAME_FAMILY, OPENAI])('switches to %s and sends one persistent notice to the originating topic', async (target) => {
    fallback.model = target;
    const wire = installWire(model => model === PRIMARY
      ? usageLimit429()
      : { events: target === OPENAI ? openaiText('Fallback answer') : anthropicText(model, 'Fallback answer') });
    const session = await createSession();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
    const editMessageText = vi.fn().mockResolvedValue(true);
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const ctx = {
      chat: { id: CHAT, type: 'supergroup' },
      message: { message_thread_id: THREAD, is_topic_message: true },
      reply: vi.fn(async () => ({ message_id: 1 })),
      telegram: { sendMessage, editMessageText, deleteMessage },
    } as unknown as Context;
    try {
      const complete = vi.fn();
      await streamResponse(ctx, session, 'hello', undefined, { cleanFinal: true, onComplete: complete });
      expect(wire.bodies.map(b => b.model)).toEqual([PRIMARY, target]);
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith(CHAT,
        expect.stringContaining(`Continuing on ${target}.`), { message_thread_id: THREAD });
      expect(complete).toHaveBeenCalledWith('Fallback answer', expect.anything());
      expect(deleteMessage.mock.calls.every(call => call[1] !== 99)).toBe(true);
      // The fallback stays active for subsequent turns without another switch.
      expect(fallbackNotices(await runTurn(session, 'again'))).toHaveLength(0);
      expect(wire.bodies.at(-1)?.model).toBe(target);
    } finally { await session.close(); }
  });

  it('switches from an OpenAI primary to Anthropic', async () => {
    fallback.model = SAME_FAMILY;
    const wire = installWire(model => model === OPENAI
      ? Object.assign(new Error('The model does not exist'), {
          status: 404, code: 'model_not_found',
          error: { code: 'model_not_found', message: 'The model does not exist' },
        })
      : { events: anthropicText(model, 'Anthropic answer') });
    const session = await createSession(OPENAI);
    try {
      const events = await runTurn(session, 'hello');
      expect(fallbackNotices(events)).toHaveLength(1);
      expect(streamedText(events)).toContain('Anthropic answer');
      expect(wire.bodies.map(b => b.model)).toEqual([OPENAI, SAME_FAMILY]);
    } finally { await session.close(); }
  });

  it('keeps the existing direct-provider path when no fallback is configured', async () => {
    fallback.model = undefined;
    const wire = installWire(model => ({ events: anthropicText(model, 'Primary answer') }));
    const session = await createSession();
    try {
      const config = (session as unknown as { config: AgentConfig }).config;
      expect(routesInjectedProviderForFallback(config)).toBe(false);
      const events = await runTurn(session, 'hello');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(streamedText(events)).toContain('Primary answer');
      expect(wire.bodies.map(b => b.model)).toEqual([PRIMARY]);
    } finally { await session.close(); }
  });

  it('does not switch on primary failure when no fallback is configured', async () => {
    fallback.model = undefined;
    const wire = installWire(model => modelNotFound404(model));
    const session = await createSession();
    try {
      const events = await runTurn(session, 'hello');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(events.some(event => event.type === 'error')).toBe(true);
      expect(wire.bodies.every(body => body.model === PRIMARY)).toBe(true);
    } finally { await session.close(); }
  });
});
