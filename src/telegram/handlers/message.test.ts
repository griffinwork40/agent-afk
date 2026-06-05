/**
 * Tests for the pendingElicitations intercept in MessageHandler.
 *
 * Verifies that a plain-text message arriving while a `pendingElicitations`
 * entry exists for the chat ID is consumed by the resolver and never reaches
 * the session message queue or processOne.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';

// ---------------------------------------------------------------------------
// Module mocks — must be before imports of the modules under test.
// ---------------------------------------------------------------------------

const { mockStreamResponse } = vi.hoisted(() => ({
  mockStreamResponse: vi.fn(async () => { /* no-op */ }),
}));

vi.mock('../streaming.js', () => ({
  streamResponse: mockStreamResponse,
}));

vi.mock('./registration.js', () => ({
  registerChatCommands: vi.fn(async () => { /* no-op */ }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { MessageHandler } from './message.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessageCtx(chatId: number, text: string): {
  ctx: Context;
  replies: string[];
} {
  const replies: string[] = [];
  const ctx = {
    chat: { id: chatId },
    message: { text } as Message.TextMessage,
    reply: vi.fn(async (msg: string) => { replies.push(msg); }),
    sendChatAction: vi.fn(async () => {}),
  } as unknown as Context;
  return { ctx, replies };
}

function makeHandler(): MessageHandler {
  const sessionManager = {
    getSession: vi.fn().mockResolvedValue({ state: 'idle' }),
    // Returns a non-idle session so that pendingElicitations entries are
    // treated as live (not stale) in the guard added to fix the stale-entry
    // regression. Tests that need to simulate a stale/reset session can
    // override this mock to return undefined or a session with state 'idle'.
    getSessionIfExists: vi.fn().mockReturnValue({ state: 'streaming' }),
    resetSession: vi.fn(),
  };
  const bot = {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({}),
    },
    command: vi.fn(),
    on: vi.fn(),
  };
  return new MessageHandler(
    bot as unknown as import('telegraf').Telegraf,
    sessionManager as unknown as import('../session-manager.js').SessionManager,
    new Set<number>(),
    vi.fn(),
  );
}

/** Creates a handler whose session is always in the 'streaming' (busy) state. */
function makeHandlerWithBusySession(): MessageHandler {
  const sessionManager = {
    getSession: vi.fn().mockResolvedValue({ state: 'streaming' }),
    getSessionIfExists: vi.fn().mockReturnValue({ state: 'streaming' }),
    resetSession: vi.fn(),
  };
  const bot = {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({}),
    },
    command: vi.fn(),
    on: vi.fn(),
  };
  return new MessageHandler(
    bot as unknown as import('telegraf').Telegraf,
    sessionManager as unknown as import('../session-manager.js').SessionManager,
    new Set<number>(),
    vi.fn(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageHandler.pendingElicitations intercept', () => {
  let handler: MessageHandler;

  beforeEach(() => {
    handler = makeHandler();
    mockStreamResponse.mockClear();
  });

  it('a message for a chat with a pending elicitation is consumed by the resolver', async () => {
    const chatId = 42;
    const resolvedValues: string[] = [];

    // Pre-seed the intercept
    handler.pendingElicitations.set(chatId, (text) => {
      resolvedValues.push(text);
    });

    const { ctx, replies } = makeMessageCtx(chatId, 'my answer');
    await handler.handle(ctx);

    // Resolver must have been called with the message text
    expect(resolvedValues).toEqual(['my answer']);
    // Entry must be deleted after consumption
    expect(handler.pendingElicitations.has(chatId)).toBe(false);
    // streamResponse (processOne) must NOT have been called
    expect(mockStreamResponse).not.toHaveBeenCalled();
    // ctx.reply must NOT have been called (no "Message queued" etc.)
    expect(replies).toHaveLength(0);
  });

  it('does not intercept messages for chats without a pending elicitation', async () => {
    const chatId = 99;
    const { ctx } = makeMessageCtx(chatId, 'a normal message');
    await handler.handle(ctx);

    // streamResponse may or may not be called depending on session state mocking,
    // but pendingElicitations must not have been modified
    expect(handler.pendingElicitations.has(chatId)).toBe(false);
  });

  it('pendingElicitations is a public Map initialized to empty', () => {
    expect(handler.pendingElicitations).toBeInstanceOf(Map);
    expect(handler.pendingElicitations.size).toBe(0);
  });

  it('consuming a pending elicitation removes the entry so subsequent messages are normal', async () => {
    const chatId = 7;
    let callCount = 0;

    handler.pendingElicitations.set(chatId, () => { callCount += 1; });

    // First message — consumed by resolver
    const { ctx: ctx1 } = makeMessageCtx(chatId, 'first');
    await handler.handle(ctx1);
    expect(callCount).toBe(1);
    expect(handler.pendingElicitations.has(chatId)).toBe(false);

    // Second message — NOT intercepted (normal flow)
    const { ctx: ctx2 } = makeMessageCtx(chatId, 'second');
    await handler.handle(ctx2);
    // callCount stays at 1 — resolver wasn't invoked again
    expect(callCount).toBe(1);
  });
});

describe('MessageHandler queue-depth acknowledgment', () => {
  const CHAT_ID = 1001;

  it('enqueued text message reply contains queue position "#1"', async () => {
    const handler = makeHandlerWithBusySession();
    const { ctx, replies } = makeMessageCtx(CHAT_ID, 'hello');

    await handler.handle(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('#1');
  });

  it('second queued message shows "#2"', async () => {
    const handler = makeHandlerWithBusySession();
    const { ctx: ctx1, replies: replies1 } = makeMessageCtx(CHAT_ID, 'first');
    const { ctx: ctx2, replies: replies2 } = makeMessageCtx(CHAT_ID, 'second');

    await handler.handle(ctx1);
    await handler.handle(ctx2);

    expect(replies1[0]).toContain('#1');
    expect(replies2[0]).toContain('#2');
  });

  it('queue-full reply does not use formatQueued (says "Queue full")', async () => {
    const handler = makeHandlerWithBusySession();
    // Fill the queue to MAX_QUEUE_DEPTH (5)
    for (let i = 0; i < 5; i++) {
      const { ctx } = makeMessageCtx(CHAT_ID, `msg${i}`);
      await handler.handle(ctx);
    }
    // 6th message hits the full-queue path
    const { ctx: overflow, replies } = makeMessageCtx(CHAT_ID, 'overflow');
    await handler.handle(overflow);

    // Queue-full message is different from the queued acknowledgment
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Queue full');
    expect(replies[0]).not.toContain('#6');
  });
});
