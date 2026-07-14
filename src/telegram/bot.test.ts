/**
 * Tests for Telegram bot
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramBot } from './bot';
import { isRateLimitError, isNetworkError } from './error-utils';
import * as skillBridge from '../agent/tools/skill-bridge.js';
import type { IAgentSession, AgentConfig, SessionState, OutputEvent } from '../agent/types';
import type { Context } from 'telegraf';

// Mock agent session with streaming
class MockAgentSession implements IAgentSession {
  state: SessionState = 'idle';
  closed = false;
  private messageQueue: OutputEvent[] = [];

  constructor(private response: string = 'Mock response') {}

  async sendMessage(content: string) {
    // Simulate streaming by queueing chunks
    const chunks = this.response.match(/.{1,50}/g) || [this.response];
    for (const chunk of chunks) {
      this.messageQueue.push({ 
        type: 'chunk', 
        chunk: { type: 'content', content: chunk } 
      });
    }
    this.messageQueue.push({ type: 'done' });

    return {
      role: 'assistant' as const,
      content: this.response,
      timestamp: new Date(),
    };
  }

  async *getOutputStream() {
    while (this.messageQueue.length > 0) {
      const event = this.messageQueue.shift();
      if (event) {
        yield event;
      }
    }
  }

  abort(_reason: string): void { /* IAgentSession mock no-op */ }
  async close() {
    this.closed = true;
  }

  async reset() {
    this.messageQueue = [];
  }
}

// Mock Telegraf context
function createMockContext(chatId: number = 12345, text: string = '/start'): Context {
  const sentMessages: string[] = [];
  const editedMessages: string[] = [];

  return {
    chat: { id: chatId, type: 'private' },
    message: {
      message_id: 1,
      text,
      date: Date.now() / 1000,
      chat: { id: chatId, type: 'private' },
    },
    reply: vi.fn(async (text: string) => {
      sentMessages.push(text);
      return {
        message_id: sentMessages.length,
        text,
        date: Date.now() / 1000,
        chat: { id: chatId, type: 'private' },
      };
    }),
    sendChatAction: vi.fn(async () => true),
    telegram: {
      editMessageText: vi.fn(async (chatId, messageId, _, text) => {
        editedMessages.push(text as string);
        return true;
      }),
    },
    __sentMessages: sentMessages,
    __editedMessages: editedMessages,
  } as unknown as Context;
}

describe('TelegramBot', () => {
  let bot: TelegramBot;
  let mockCreateSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCreateSession = vi.fn(async (config: AgentConfig) => new MockAgentSession());

    bot = new TelegramBot({
      botToken: 'test-token',
      apiKey: 'test-api-key',
      dataDir: './test-data/bot-sessions',
      verbose: false,
      allowedChatIds: new Set([12345]),
      createSession: mockCreateSession,
    });
  });

  afterEach(async () => {
    // Clean up
    if (bot) {
      await bot.stop().catch(() => {});
    }
  });

  describe('construction', () => {
    test('disables Telegraf handlerTimeout so long turns are governed by the streaming watchdog, not a 90s guillotine', () => {
      // Regression: Telegraf's default handlerTimeout (90_000ms) p-timeouts the
      // whole turn → bot.catch → generic error, while the AgentSession keeps
      // running in the background. streaming.ts owns timeout policy instead.
      const handlerTimeout = (
        bot as unknown as { bot: { options: { handlerTimeout: number } } }
      ).bot.options.handlerTimeout;
      expect(handlerTimeout).toBe(Infinity);
      expect(handlerTimeout).not.toBe(90_000);
    });
  });

  describe('commands', () => {
    test('should handle /start command', async () => {
      const ctx = createMockContext(12345, '/start');
      
      // Manually trigger start handler (without actually starting bot)
      await (bot as any).handleStart(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const message = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(message).toContain('Welcome');
    });

    test('should handle /clear command (SDK /clear)', async () => {
      const ctx = createMockContext(12345, '/clear');

      await (bot as any).handleClear(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const message = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(message).toContain('cleared');
    });

    test('should handle /model command without args', async () => {
      const ctx = createMockContext(12345, '/model');
      
      await (bot as any).handleModelSwitch(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const [message, options] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
      expect(message).toContain('Current model');
      // New: inline keyboard must be present
      expect(options).toBeDefined();
      expect((options as { reply_markup?: unknown })?.reply_markup).toBeDefined();
    });

    test('/model inline keyboard: annotates unavailable handles additively, callback_data unchanged', async () => {
      const availability = await import('../agent/auth/model-availability.js');
      const spy = vi
        .spyOn(availability, 'isModelAvailable')
        .mockImplementation((model) => model !== 'opus');

      try {
        const ctx = createMockContext(12345, '/model');
        await (bot as any).handleModelSwitch(ctx);

        const [, options] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
          string,
          { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } },
        ];
        const rows = options.reply_markup?.inline_keyboard ?? [];
        const flat = rows.flat();

        // Every alias handle is still present and selectable (additive-only).
        expect(flat.length).toBeGreaterThan(0);
        const opusButton = flat.find((b) => b.callback_data === 'afk:m:opus');
        expect(opusButton).toBeDefined();
        // Label carries the marker; callback-data used for routing is untouched.
        expect(opusButton?.text).toBe('opus — needs sign-in');
        expect(opusButton?.callback_data).toBe('afk:m:opus');

        // An available handle (e.g. sonnet) keeps its bare label.
        const sonnetButton = flat.find((b) => b.callback_data === 'afk:m:sonnet');
        expect(sonnetButton?.text).toBe('sonnet');
      } finally {
        spy.mockRestore();
      }
    });

    test('should handle /model command with valid model', async () => {
      const ctx = createMockContext(12345, '/model opus');
      
      await (bot as any).handleModelSwitch(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const message = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(message.toLowerCase()).toContain('opus');
    });

    test('should reject invalid model', async () => {
      const ctx = createMockContext(12345, '/model invalid');
      
      await (bot as any).handleModelSwitch(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const message = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(message).toContain('Invalid model');
    });

    test('should handle /help command', async () => {
      const ctx = createMockContext(12345, '/help');

      await (bot as any).handleHelp(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const message = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(message).toContain('/help');
      expect(message).toContain('CLI');
    });
  });

  describe('message handling', () => {
    test('should handle user messages', async () => {
      const ctx = createMockContext(12345, 'Hello!');
      
      await (bot as any).handleMessage(ctx);

      expect(ctx.sendChatAction).toHaveBeenCalledWith('typing');
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('should ignore command messages', async () => {
      const ctx = createMockContext(12345, '/start');
      
      await (bot as any).handleMessage(ctx);

      // Should not send typing or reply (commands handled separately)
      expect(ctx.sendChatAction).not.toHaveBeenCalled();
    });

    test('should create session for new chat', async () => {
      const ctx = createMockContext(12345, 'Hello!');
      
      await (bot as any).handleMessage(ctx);

      expect(mockCreateSession).toHaveBeenCalled();
    });

    test('should stream long responses', async () => {
      const longResponse = 'x'.repeat(2000);
      mockCreateSession.mockImplementation(
        async () => new MockAgentSession(longResponse)
      );

      const ctx = createMockContext(12345, 'Tell me a story');
      
      await (bot as any).handleMessage(ctx);

      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  describe('polling loop is not blocked by an in-flight turn (elicitation deadlock regression)', () => {
    test('the registered text update handler returns before the turn completes', async () => {
      // Regression for the path-approval "buttons do nothing" deadlock:
      // Telegraf's long-poll loop awaits every handler in a batch before it
      // fetches the next getUpdates batch. If the 'text' handler AWAITS the agent
      // turn, a turn wedged on a mid-turn elicitation (waiting for a button tap /
      // text reply that only arrives on a LATER update) freezes the poller — the
      // resolving update can never be fetched. The turn must run DETACHED so
      // handleUpdate resolves immediately and the poller keeps polling.
      const neverResolves = new Promise<void>(() => {
        /* a turn blocked forever on an unanswerable elicitation */
      });
      const handleSpy = vi
        .spyOn((bot as any).messageHandler, 'handle')
        .mockReturnValue(neverResolves);

      // Pre-seed botInfo so Telegraf's handleUpdate does not call getMe() over
      // the network (offline test) before running the middleware chain.
      (bot as any).bot.botInfo = {
        id: 42,
        is_bot: true,
        first_name: 'Test',
        username: 'test_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      };

      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          text: 'read /tmp/x',
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: 'private' },
          from: { id: 12345, is_bot: false, first_name: 'T' },
        },
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'handleUpdate blocked on the in-flight turn — polling deadlock regression',
              ),
            ),
          500,
        );
      });
      try {
        // If the handler awaited the turn, this race would reject via `guard`.
        await expect(
          Promise.race([(bot as any).bot.handleUpdate(update), guard]),
        ).resolves.toBeUndefined();
      } finally {
        if (timer) clearTimeout(timer);
      }

      // The turn WAS dispatched (not dropped) — just not awaited by the poller.
      expect(handleSpy).toHaveBeenCalledTimes(1);
      handleSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    test('should detect rate limit errors', () => {
      const error = new Error('Rate limit exceeded');
      expect(isRateLimitError(error)).toBe(true);

      const error2 = new Error('Too many requests');
      expect(isRateLimitError(error2)).toBe(true);
    });

    test('should detect network errors', () => {
      const error = new Error('Network connection failed');
      expect(isNetworkError(error)).toBe(true);

      const error2 = new Error('Connection timeout');
      expect(isNetworkError(error2)).toBe(true);
    });

    test('should handle errors gracefully', async () => {
      mockCreateSession.mockImplementation(async () => {
        throw new Error('Test error');
      });

      const ctx = createMockContext(12345, 'Hello');
      
      await (bot as any).handleMessage(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const message = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(message).toContain('⚠️');
    });
  });

  describe('stats', () => {
    test('should track bot stats', () => {
      const stats = bot.getStats();
      expect(stats).toHaveProperty('running');
      expect(stats).toHaveProperty('activeSessions');
      expect(stats).toHaveProperty('totalChats');
    });

    test('should report not running initially', () => {
      const stats = bot.getStats();
      expect(stats.running).toBe(false);
    });
  });

  describe('lifecycle', () => {
    test('should not allow starting twice', async () => {
      // Mock Telegraf network calls reached in start()
      (bot as any).bot.launch = vi.fn(async () => {});
      (bot as any).bot.telegram.setMyCommands = vi.fn(async () => {});

      await bot.start();
      await expect(bot.start()).rejects.toThrow('already running');
      await bot.stop();
    });

    test('should allow stop even if not running', async () => {
      await expect(bot.stop()).resolves.not.toThrow();
    });

    test('loads plugin entrypoints before launching the bot', async () => {
      // Invariant: a plugin's registerSkill() side-effects must run before the
      // first update is handled, because each per-chat session assembles its
      // skill manifest synchronously at construction. Lock the ordering:
      // ensurePluginEntrypointsLoaded() must be awaited before bot.launch().
      const order: string[] = [];
      const entrypointsSpy = vi
        .spyOn(skillBridge, 'ensurePluginEntrypointsLoaded')
        .mockImplementation(async () => {
          order.push('entrypoints');
        });
      (bot as any).bot.launch = vi.fn(async () => {
        order.push('launch');
      });
      (bot as any).bot.telegram.setMyCommands = vi.fn(async () => {});

      await bot.start();
      await bot.stop();

      expect(entrypointsSpy).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['entrypoints', 'launch']);
      entrypointsSpy.mockRestore();
    });
  });
});
