/**
 * Reproducer: unawaited this.drainQueue(chatId) in processOne's finally block
 *
 * Bug location: src/telegram/handlers/message.ts:148
 *   finally { this.drainQueue(chatId); }   ← no await, no .catch
 *
 * Observable consequence:
 *   When the drained message's processOne runs and its catch block calls
 *   ctx.reply(), and THAT throws (e.g. Telegram rejects the reply — bot
 *   blocked), the error escapes processOne entirely. Because drainQueue was
 *   called without await or .catch, this rejection is a detached floating
 *   promise — it becomes an unhandled rejection invisible to any caller.
 *   No log entry is emitted for the secondary failure; the queued user
 *   silently gets nothing.
 *
 * Test design (FAILS pre-patch, passes post-patch):
 *   The test asserts the CORRECT behaviour — that the drain error is
 *   logged (caught) and does NOT surface as an unhandled rejection.
 *   Pre-patch: the unawaited drainQueue swallows the error → unhandled
 *   rejection IS captured → assertion "no unhandled rejections" FAILS.
 *   Post-patch (await or .catch(log) on drainQueue): the error is caught
 *   and logged → no unhandled rejection → test passes.
 *
 * Setup:
 *   - streamResponse resolves for ctxA (call 1), throws for ctxB (call 2)
 *   - ctxB.reply call #1 ("Message queued.") succeeds
 *   - ctxB.reply call #2 (error reply inside processOne catch) throws —
 *     simulating a Telegram rejection (e.g. user blocked the bot)
 *   - We capture process unhandledRejection events during the test window
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from '../../src/telegram/handlers/message.js';
import type { Context } from 'telegraf';
import type { IAgentSession } from '../../src/agent/types.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/telegram/streaming.js', () => ({
  streamResponse: vi.fn(),
}));

vi.mock('../../src/telegram/handlers/registration.js', () => ({
  registerChatCommands: vi.fn().mockResolvedValue(undefined),
}));

import { streamResponse } from '../../src/telegram/streaming.js';

// ── Helper factories ──────────────────────────────────────────────────────────

function makeSession(state: 'idle' | 'processing' = 'idle'): IAgentSession {
  return { state } as unknown as IAgentSession;
}

/**
 * Build a Context mock.
 * @param replyThrowOnCall  If set, reply() throws on that call number (1-based).
 */
function makeCtx(
  chatId: number,
  text: string,
  replyThrowOnCall?: number
): Context {
  let replyCallCount = 0;
  return {
    chat: { id: chatId, type: 'private' as const },
    message: {
      message_id: 1,
      text,
      date: Date.now() / 1000,
      chat: { id: chatId, type: 'private' as const },
    },
    reply: vi.fn(async (_text: string) => {
      replyCallCount++;
      if (replyThrowOnCall !== undefined && replyCallCount === replyThrowOnCall) {
        throw new Error('Telegram: reply failed (bot blocked)');
      }
      return { message_id: replyCallCount, text: _text };
    }),
    sendChatAction: vi.fn().mockResolvedValue(true),
    telegram: {
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function makeTelegraf() {
  return {
    telegram: { setMyCommands: vi.fn().mockResolvedValue(undefined) },
  } as any;
}

/**
 * SessionManager stub returning states by call index:
 *   index 0 → handle(ctxA) outer call → 'idle'  → goes to processOne
 *   index 1 → handle(ctxB) outer call → 'processing' → enqueue + "Message queued."
 *   index 2 → drainQueue → processOne(ctxB) inner call → 'idle'
 */
function makeSessionManager(states: Array<'idle' | 'processing'>) {
  let callCount = 0;
  return {
    getSession: vi.fn(async (_chatId: number) => {
      const state = states[callCount] ?? 'idle';
      callCount++;
      return makeSession(state);
    }),
    resetSession: vi.fn().mockResolvedValue(undefined),
  } as any;
}

/** Flush all pending microtasks and macrotasks. */
async function flushPromises(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe('MessageHandler.drainQueue — unawaited finally bug', () => {
  let unhandledRejections: Error[] = [];
  let unhandledHandler: (reason: unknown) => void;

  beforeEach(() => {
    unhandledRejections = [];
    unhandledHandler = (reason: unknown) => {
      unhandledRejections.push(
        reason instanceof Error ? reason : new Error(String(reason))
      );
    };
    process.on('unhandledRejection', unhandledHandler);
    vi.mocked(streamResponse).mockReset();
  });

  afterEach(() => {
    process.off('unhandledRejection', unhandledHandler);
    vi.restoreAllMocks();
  });

  it(
    'drain errors must NOT become unhandled rejections (FAILS pre-patch, passes post-patch)',
    async () => {
      const CHAT_ID = 100;
      const logSpy = vi.fn();
      const bot = makeTelegraf();

      const sessionManager = makeSessionManager(['idle', 'processing', 'idle']);

      const handler = new MessageHandler(
        bot,
        sessionManager,
        new Set<number>(),
        logSpy
      );

      // streamResponse: resolves for ctxA (call 1), throws for ctxB (call 2).
      // The throw causes processOne's catch block to call ctx.reply(formatError(err)).
      const streamError = new Error('stream failure for ctxB');
      let streamCallCount = 0;
      vi.mocked(streamResponse).mockImplementation(async () => {
        streamCallCount++;
        if (streamCallCount >= 2) {
          throw streamError;
        }
      });

      // ctxA: all replies succeed.
      const ctxA = makeCtx(CHAT_ID, 'hi A');

      // ctxB reply call #1: "Message queued." — must succeed (handle outer, line 65).
      // ctxB reply call #2: formatError(streamError) — throws (processOne catch, line 145).
      // This simulates Telegram rejecting the error reply (e.g. user blocked bot).
      const ctxB = makeCtx(CHAT_ID, 'hi B', /* replyThrowOnCall= */ 2);

      // handle(ctxA): idle → processOne → streamResponse ok → finally drainQueue() [no await]
      // handle(ctxB): processing → enqueue → "Message queued." reply → return
      // drainQueue fires detached: processOne(ctxB) → streamResponse throws →
      //   catch: log(streamError), ctx.reply throws → error escapes processOne →
      //   detached rejection (never caught by anyone with the bug)
      await Promise.all([
        handler.handle(ctxA),
        handler.handle(ctxB),
      ]);

      // Allow detached drainQueue promise chain to run to completion.
      await flushPromises(30);

      // ── Assertions (describe CORRECT behaviour; fail pre-patch) ─────────────

      // CORRECT: drain processing both messages (not blocked).
      expect(streamCallCount).toBe(2);

      // CORRECT: ctxB.reply was called at least twice (queued ack + error reply).
      expect(vi.mocked(ctxB.reply).mock.calls.length).toBeGreaterThanOrEqual(2);

      // CORRECT: the reply-throw error from the drain MUST be caught and
      // logged via the drain-specific log key, not by ctxA's outer handler.
      // Pre-patch: drainQueue is unawaited → rejection floats free → no
      // 'Drain error:' log entry → this assertion FAILS.
      // `await drainQueue` fix: error propagates to handle(ctxA)'s catch,
      // which logs under 'Message handling error:' — this assertion still
      // FAILS, correctly rejecting the wrong fix.
      // `void+.catch(log)` fix: 'Drain error:' is logged here, in the drain's
      // own scope → passes.
      const drainErrorLogged = logSpy.mock.calls.some(
        call =>
          call[0] === 'Drain error:' &&
          call[1] instanceof Error &&
          call[1].message.includes('reply failed')
      );
      expect(drainErrorLogged).toBe(true); // FAILS pre-patch

      // CORRECT: ctxA must NOT receive a reply about ctxB's failure.
      // Pre-patch: ctxA.reply is not called (drain is detached + swallowed) →
      // this assertion passes for the wrong reason.
      // `await drainQueue` fix: ctxA.reply IS called with ctxB's error msg
      // (cross-context UX regression) → this assertion FAILS, rejecting it.
      // `void+.catch(log)` fix: ctxA.reply is not called → passes.
      // ctxA.reply is allowed once for any pre-drain reply, but must NOT
      // contain 'reply failed' (ctxB's error).
      const ctxAReplies = vi.mocked(ctxA.reply).mock.calls.map(c => c[0]);
      const ctxALeakedCtxBError = ctxAReplies.some(
        (msg: unknown) => typeof msg === 'string' && msg.includes('reply failed')
      );
      expect(ctxALeakedCtxBError).toBe(false);

      // CORRECT: no unhandled rejections — drain errors must not escape.
      // Pre-patch: the rejection is detached → captured by our listener →
      // this assertion FAILS.
      // Post-patch: error is caught → zero unhandled rejections → passes.
      expect(unhandledRejections.length).toBe(0); // FAILS pre-patch
    }
  );
});
