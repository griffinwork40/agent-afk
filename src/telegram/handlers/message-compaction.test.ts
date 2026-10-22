/**
 * Tests for compact command queuing in MessageHandler.
 *
 * Covers:
 *   A — message arriving while session is 'compacting' is queued (not processed).
 *   B — queued message drains after compact completes.
 *   C — /compact enqueue while session is processing; drain fires session.compact().
 *   D — queued /compact draining against a busy session (TOCTOU) re-enqueues
 *       instead of surfacing the misleading "Nothing to compact" no-op.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import type { IAgentSession, OutputEvent } from '../../agent/types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

// ---------------------------------------------------------------------------
// Module mocks — must be before imports of the modules under test.
// ---------------------------------------------------------------------------

const { mockStreamResponse } = vi.hoisted(() => ({
  mockStreamResponse: vi.fn<[Context, IAgentSession, string | ContentBlockParam[], ((...args: unknown[]) => void)?], Promise<void>>(
    async () => { /* resolved immediately */ }
  ),
}));

vi.mock('../streaming.js', () => ({
  streamResponse: mockStreamResponse,
}));

vi.mock('./registration.js', () => ({
  registerChatCommands: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { MessageHandler } from './message.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(state: 'idle' | 'processing' | 'streaming' | 'compacting' | 'closed' = 'idle'): IAgentSession {
  return {
    state,
    compact: vi.fn().mockResolvedValue({ compacted: false, reason: 'not-supported', messagesBefore: 0, messagesAfter: 0 }),
    sendMessage: vi.fn(),
    sendMessageStream: vi.fn(async function* (): AsyncGenerator<OutputEvent> {
      yield { type: 'done' as const, metadata: undefined };
    }),
    getOutputStream: vi.fn(),
    close: vi.fn(),
    waitForInitialization: vi.fn().mockResolvedValue({}),
    getSessionIdentity: vi.fn().mockReturnValue({}),
    getSessionMetadata: vi.fn().mockReturnValue({}),
    getQuery: vi.fn(),
    getLastResponseMetadata: vi.fn().mockReturnValue(null),
    interrupt: vi.fn(),
    reset: vi.fn(),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({}),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
    abortSignal: new AbortController().signal,
    getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
    abort: vi.fn(),
    listRewindTargets: vi.fn().mockReturnValue([]),
  } as unknown as IAgentSession;
}

function makeCtx(chatId: number, text: string): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    chat: { id: chatId },
    message: { text } as Message.TextMessage,
    reply: vi.fn(async (msg: string) => { replies.push(msg); }),
    sendChatAction: vi.fn(async () => {}),
  } as unknown as Context;
  return { ctx, replies };
}

function makeCompactCtx(chatId: number): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    chat: { id: chatId },
    message: { text: '/compact' } as Message.TextMessage,
    reply: vi.fn(async (msg: string) => { replies.push(msg); }),
    sendChatAction: vi.fn(async () => {}),
  } as unknown as Context;
  return { ctx, replies };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageHandler — compaction queuing', () => {
  let mockBot: object;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { on: vi.fn(), command: vi.fn(), use: vi.fn() };
  });

  // -------------------------------------------------------------------------
  // Group A: message arriving during compaction is queued
  // -------------------------------------------------------------------------
  describe('Group A — text message arrives while session is compacting', () => {
    it('queues the message and replies with a queue position without calling streamResponse', async () => {
      const chatId = 42;
      const session = makeSession('compacting');
      const sessionManager = {
        getSession: vi.fn().mockResolvedValue(session),
        getSessionIfExists: vi.fn().mockReturnValue(session),
        resetSession: vi.fn(),
      };
      const handler = new MessageHandler(
        mockBot as any,
        sessionManager as any,
        new Set(),
        vi.fn()
      );

      const { ctx, replies } = makeCtx(chatId, 'hello while compacting');
      await handler.handle(ctx);

      // Now uses formatQueued — check for queue indicator rather than exact string
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('#1');
      expect(mockStreamResponse).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Group B: queued message drains after compact completes
  // -------------------------------------------------------------------------
  describe('Group B — queued message drains after compact finishes', () => {
    it('processes the queued message when drainQueue is called', async () => {
      const chatId = 99;
      // First call returns compacting (message gets queued), second returns idle (drain processes it)
      const compactingSession = makeSession('compacting');
      const idleSession = makeSession('idle');
      const sessionManager = {
        getSession: vi.fn()
          .mockResolvedValueOnce(compactingSession)  // first handle() call sees compacting
          .mockResolvedValue(idleSession),            // drain call sees idle
        getSessionIfExists: vi.fn().mockReturnValue(compactingSession),
        resetSession: vi.fn(),
      };
      const handler = new MessageHandler(
        mockBot as any,
        sessionManager as any,
        new Set(),
        vi.fn()
      );

      const { ctx } = makeCtx(chatId, 'drain me');
      await handler.handle(ctx);

      expect(mockStreamResponse).not.toHaveBeenCalled();

      // Now drain (simulates what happens after compact() finishes)
      await handler.drainQueue({ chatId });

      expect(mockStreamResponse).toHaveBeenCalledOnce();
      expect(mockStreamResponse).toHaveBeenCalledWith(
        expect.anything(),
        idleSession,
        'drain me',
        expect.anything(),
        expect.objectContaining({ cleanFinal: true })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Group C: /compact enqueue while session is processing
  // -------------------------------------------------------------------------
  describe('Group C — enqueueCompact while session is processing', () => {
    it('adds a compact item to the queue and calls session.compact() on drain', async () => {
      const chatId = 7;
      const idleSession = makeSession('idle');
      const sessionManager = {
        getSession: vi.fn().mockResolvedValue(idleSession),
        getSessionIfExists: vi.fn().mockReturnValue(makeSession('processing')),
        resetSession: vi.fn(),
        getStats: vi.fn(() => ({ model: 'sonnet' })),
      };
      const handler = new MessageHandler(
        mockBot as any,
        sessionManager as any,
        new Set(),
        vi.fn()
      );

      const { ctx } = makeCompactCtx(chatId);
      handler.enqueueSlash({ chatId }, ctx, '/compact');

      // Drain the queue — processCompactDirect should call session.compact()
      await handler.drainQueue({ chatId });

      expect(idleSession.compact).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Group D: queued /compact drains against a busy session (TOCTOU)
  //
  // compact() returns { compacted: false, reason: 'session-busy' } (it does NOT
  // throw) when a new turn started between drain-start and the compact() call.
  // The handler must re-enqueue the compact rather than surface the misleading
  // "Nothing to compact (session-busy)" no-op and drop the request.
  // -------------------------------------------------------------------------
  // Group D (Stage 5): the shared /compact runs under the route's turn
  // reservation, so a turn cannot start mid-compact (the old session-busy
  // TOCTOU). A drain that finds the session busy re-queues instead.
  describe('Group D — queued /compact drains while session is busy', () => {
    it('re-enqueues the compact without compacting when the session is busy at drain', async () => {
      const chatId = 11;
      const busySession = makeSession('processing');
      const sessionManager = {
        getSession: vi.fn().mockResolvedValue(busySession),
        getSessionIfExists: vi.fn().mockReturnValue(busySession),
        getStats: vi.fn(),
      };
      const handler = new MessageHandler(mockBot as any, sessionManager as any, new Set(), vi.fn());
      const { ctx } = makeCompactCtx(chatId);
      handler.enqueueSlash({ chatId }, ctx, '/compact');
      await handler.drainQueue({ chatId });
      expect(busySession.compact).not.toHaveBeenCalled();
      const queue = (handler as any).messageQueues.get(String(chatId));
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ type: 'slash', text: '/compact' });
    });
  });
});
