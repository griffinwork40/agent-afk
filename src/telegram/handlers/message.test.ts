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

// ---------------------------------------------------------------------------
// TOCTOU regression: two near-simultaneous same-chat updates must not both
// become the active turn (PR #602 review — Codex P1).
//
// bot.ts now dispatches the Telegraf 'text'/'photo' handlers detached, so a
// second update for the same chat can be fetched and run concurrently with
// the first, before the first's `session.state` has actually flipped away
// from 'idle' (that flip happens deep inside sendMessageStream, after
// getSession() and streaming.ts's "Thinking…" placeholder send). The mocked
// sessionManager here always resolves `{ state: 'idle' }` regardless of how
// many times it is called — exactly modeling that window — so without the
// synchronous `claimedChats` reservation, BOTH concurrent handle() calls
// would see 'idle' and both would reach processOne/streamResponse.
// ---------------------------------------------------------------------------

describe('MessageHandler concurrent same-chat dispatch (TOCTOU regression — PR #602 Codex P1)', () => {
  const CHAT_ID = 2002;

  beforeEach(() => {
    mockStreamResponse.mockClear();
  });

  it('a second concurrent update for the same chat is queued, not processed concurrently', async () => {
    // getSession always resolves { state: 'idle' } — never reflects a real
    // busy transition — so this reproduces exactly the unprotected window:
    // only the claimedChats guard (not session.state) can serialize these.
    const handler = makeHandler();
    const { ctx: ctx1, replies: replies1 } = makeMessageCtx(CHAT_ID, 'first');
    const { ctx: ctx2, replies: replies2 } = makeMessageCtx(CHAT_ID, 'second');

    // Dispatch both without awaiting between them — exactly what bot.ts's
    // runDetached now allows via two back-to-back polling batches.
    await Promise.all([handler.handle(ctx1), handler.handle(ctx2)]);

    // Exactly one of the two `handle()` calls must have gone straight to
    // processOne; the other must have been queued (a "Queued #1" reply) —
    // never both racing into processOne directly from their own idle-check.
    // (The queued item may then be drained and processed SEQUENTIALLY once
    // the winner's turn finishes — that pre-existing drainQueue behavior is
    // expected and is not what this test guards against; only CONCURRENT
    // double-entry from two independent handle() calls is the regression.)
    const queuedReplies = [...replies1, ...replies2].filter((r) => r.includes('#1'));
    expect(queuedReplies).toHaveLength(1);

    // The winning call's own replies stay empty — handle()'s direct-process
    // path never calls ctx.reply itself (only the enqueue path does).
    const winnerReplies = queuedReplies[0] && replies1.includes(queuedReplies[0]) ? replies2 : replies1;
    expect(winnerReplies).toHaveLength(0);

    // streamResponse must have fired at least once (the winner's own turn).
    expect(mockStreamResponse).toHaveBeenCalled();
  });

  it('releases the claim after the turn completes so a later message for the same chat still processes normally', async () => {
    const handler = makeHandler();
    const { ctx: ctx1 } = makeMessageCtx(CHAT_ID, 'first');
    await handler.handle(ctx1);
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);

    // A subsequent, non-concurrent message must process normally — the
    // claim must not leak past the turn that reserved it.
    const { ctx: ctx2, replies: replies2 } = makeMessageCtx(CHAT_ID, 'second');
    await handler.handle(ctx2);
    expect(mockStreamResponse).toHaveBeenCalledTimes(2);
    expect(replies2).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 (C3): ledger-originated pending resolver bypass (idle-guard fix)
// ---------------------------------------------------------------------------

describe('MessageHandler.ledgerOriginatedPendingChats bypass (C3)', () => {
  it('fires a ledger-originated pending resolver even with no active session (no session at all)', async () => {
    // Simulate no session in the manager: getSessionIfExists returns undefined.
    const sessionManager = {
      getSession: vi.fn().mockResolvedValue({ state: 'idle' }),
      getSessionIfExists: vi.fn().mockReturnValue(undefined),
      resetSession: vi.fn(),
    };
    const bot = {
      telegram: { sendMessage: vi.fn().mockResolvedValue({}) },
      command: vi.fn(),
      on: vi.fn(),
    };
    const handler = new MessageHandler(
      bot as unknown as import('telegraf').Telegraf,
      sessionManager as unknown as import('../session-manager.js').SessionManager,
      new Set<number>(),
      vi.fn(),
    );

    const chatId = 55;
    const resolved: string[] = [];

    // Pre-seed as ledger-originated (as makeTelegramElicitationHandler would do).
    handler.pendingElicitations.set(chatId, (text) => resolved.push(text));
    handler.ledgerOriginatedPendingChats.add(chatId);

    const { ctx } = makeMessageCtx(chatId, 'ledger answer');
    await handler.handle(ctx);

    // Resolver must fire even though there is no active session.
    expect(resolved).toEqual(['ledger answer']);
    // Both maps must be cleaned up after consumption.
    expect(handler.pendingElicitations.has(chatId)).toBe(false);
    expect(handler.ledgerOriginatedPendingChats.has(chatId)).toBe(false);
  });

  it('fires a ledger-originated pending resolver even when session is idle', async () => {
    // Session exists but is idle — session-local path would drop this as stale.
    const sessionManager = {
      getSession: vi.fn().mockResolvedValue({ state: 'idle' }),
      getSessionIfExists: vi.fn().mockReturnValue({ state: 'idle' }),
      resetSession: vi.fn(),
    };
    const bot = {
      telegram: { sendMessage: vi.fn().mockResolvedValue({}) },
      command: vi.fn(),
      on: vi.fn(),
    };
    const handler = new MessageHandler(
      bot as unknown as import('telegraf').Telegraf,
      sessionManager as unknown as import('../session-manager.js').SessionManager,
      new Set<number>(),
      vi.fn(),
    );

    const chatId = 56;
    const resolved: string[] = [];

    handler.pendingElicitations.set(chatId, (text) => resolved.push(text));
    handler.ledgerOriginatedPendingChats.add(chatId);

    const { ctx } = makeMessageCtx(chatId, 'idle session answer');
    await handler.handle(ctx);

    expect(resolved).toEqual(['idle session answer']);
    expect(handler.pendingElicitations.has(chatId)).toBe(false);
    expect(handler.ledgerOriginatedPendingChats.has(chatId)).toBe(false);
  });

  it('still drops a genuinely stale session-local entry (no ledger-origin flag) when session is idle', async () => {
    // Session exists but is idle — this simulates a session reset mid-elicitation.
    const sessionManager = {
      getSession: vi.fn().mockResolvedValue({ state: 'idle' }),
      getSessionIfExists: vi.fn().mockReturnValue({ state: 'idle' }),
      resetSession: vi.fn(),
    };
    const bot = {
      telegram: { sendMessage: vi.fn().mockResolvedValue({}) },
      command: vi.fn(),
      on: vi.fn(),
    };
    const handler = new MessageHandler(
      bot as unknown as import('telegraf').Telegraf,
      sessionManager as unknown as import('../session-manager.js').SessionManager,
      new Set<number>(),
      vi.fn(),
    );

    const chatId = 57;
    let resolverCalled = false;

    // Pre-seed WITHOUT the ledger-origin flag (session-local, now stale).
    handler.pendingElicitations.set(chatId, () => { resolverCalled = true; });
    // ledgerOriginatedPendingChats NOT set — this is the stale-session path.

    const { ctx } = makeMessageCtx(chatId, 'stale reply');
    await handler.handle(ctx);

    // Resolver must NOT fire — the stale-session guard must drop it.
    expect(resolverCalled).toBe(false);
    // The stale entry must be cleaned up.
    expect(handler.pendingElicitations.has(chatId)).toBe(false);
  });

  it('ledgerOriginatedPendingChats is a public Set initialized to empty', () => {
    const handler = makeHandler();
    expect(handler.ledgerOriginatedPendingChats).toBeInstanceOf(Set);
    expect(handler.ledgerOriginatedPendingChats.size).toBe(0);
  });
});
