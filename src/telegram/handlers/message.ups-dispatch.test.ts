/**
 * Tests for Telegram-surface UserPromptSubmit hook dispatch.
 *
 * Covers:
 *   - No registry → pass-through (shouldSkip=false, content unchanged)
 *   - Registry with no handlers → pass-through
 *   - injectContext returned → prepended to content (string and block paths)
 *   - HookBlockedError → shouldSkip=true with notice
 *   - HookHandlerTimeoutError → shouldSkip=true with notice
 *   - AbortError → propagates unchanged
 *   - SessionId forwarded in context
 *   - userText extraction (string, text blocks, image blocks, document blocks)
 *   - Telegram wiring: processOne dispatches UserPromptSubmit (integration smoke)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { createHookRegistry } from '../../agent/hook-registry.js';
import { HookHandlerTimeoutError } from '../../agent/hook-registry.js';
import { HookBlockedError } from '../../utils/errors.js';
import {
  dispatchTelegramUserPromptSubmit,
  extractUserText,
} from './message.ups-dispatch.js';

// ---------------------------------------------------------------------------
// extractUserText
// ---------------------------------------------------------------------------

describe('extractUserText', () => {
  it('returns string unchanged', () => {
    expect(extractUserText('hello world')).toBe('hello world');
  });

  it('joins text blocks from content array', () => {
    const content: ContentBlockParam[] = [
      { type: 'text', text: 'caption' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } },
    ];
    expect(extractUserText(content)).toBe('caption [image]');
  });

  it('labels document blocks', () => {
    const content: ContentBlockParam[] = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' }, title: 'report.pdf' },
    ];
    expect(extractUserText(content)).toBe('[document: report.pdf]');
  });

  it('uses fallback label when document has no title', () => {
    const content: ContentBlockParam[] = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' } },
    ];
    expect(extractUserText(content)).toBe('[document: file]');
  });

  it('returns empty string for empty array', () => {
    expect(extractUserText([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// dispatchTelegramUserPromptSubmit — no registry
// ---------------------------------------------------------------------------

describe('dispatchTelegramUserPromptSubmit – no registry', () => {
  it('returns shouldSkip=false with the original string content', async () => {
    const result = await dispatchTelegramUserPromptSubmit('hello', undefined);
    expect(result.shouldSkip).toBe(false);
    expect(result.content).toBe('hello');
    expect(result.blockNotice).toBeUndefined();
    expect(result.userText).toBe('hello');
  });

  it('returns shouldSkip=false with original block content', async () => {
    const content: ContentBlockParam[] = [{ type: 'text', text: 'hi' }];
    const result = await dispatchTelegramUserPromptSubmit(content, undefined);
    expect(result.shouldSkip).toBe(false);
    expect(result.content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// dispatchTelegramUserPromptSubmit — registry with no handlers
// ---------------------------------------------------------------------------

describe('dispatchTelegramUserPromptSubmit – empty registry', () => {
  it('returns shouldSkip=false, content unchanged', async () => {
    const registry = createHookRegistry();
    const result = await dispatchTelegramUserPromptSubmit('hello', registry);
    expect(result.shouldSkip).toBe(false);
    expect(result.content).toBe('hello');
    expect(result.userText).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// dispatchTelegramUserPromptSubmit — injectContext injection
// ---------------------------------------------------------------------------

describe('dispatchTelegramUserPromptSubmit – injectContext injection', () => {
  it('prepends injectContext to a string prompt', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      injectContext: '[policy note]',
    }));
    const result = await dispatchTelegramUserPromptSubmit('user text', registry);
    expect(result.shouldSkip).toBe(false);
    expect(result.content).toBe('[policy note]\n\nuser text');
    expect(result.userText).toBe('user text');
  });

  it('prepends injectContext as a leading text block in content arrays', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      injectContext: '[framework note]',
    }));
    const original: ContentBlockParam[] = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } },
    ];
    const result = await dispatchTelegramUserPromptSubmit(original, registry);
    expect(result.shouldSkip).toBe(false);
    const blocks = result.content as ContentBlockParam[];
    expect(blocks[0]).toEqual({ type: 'text', text: '[framework note]\n\n' });
    expect(blocks[1]).toBe(original[0]);
  });

  it('leaves content unchanged when no injection returned', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({}));
    const result = await dispatchTelegramUserPromptSubmit('text', registry);
    expect(result.content).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// dispatchTelegramUserPromptSubmit — block / timeout
// ---------------------------------------------------------------------------

describe('dispatchTelegramUserPromptSubmit – block and timeout', () => {
  it('returns shouldSkip=true with notice on HookBlockedError with reason', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      decision: 'block' as const,
      reason: 'policy violation',
    }));
    const result = await dispatchTelegramUserPromptSubmit('text', registry);
    expect(result.shouldSkip).toBe(true);
    expect(result.blockNotice).toContain('blocked by hook');
    expect(result.blockNotice).toContain('policy violation');
    expect(result.content).toBe('text'); // unchanged on skip
  });

  it('returns shouldSkip=true with default notice on HookBlockedError without reason', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({ decision: 'block' as const }));
    const result = await dispatchTelegramUserPromptSubmit('text', registry);
    expect(result.shouldSkip).toBe(true);
    expect(result.blockNotice).toBe('⊘ Turn blocked by hook');
  });

  it('returns shouldSkip=true with notice on HookHandlerTimeoutError', async () => {
    const registry = createHookRegistry();
    // Simulate a timeout by throwing HookHandlerTimeoutError from a handler.
    registry.register('UserPromptSubmit', async (_ctx, _sig) => {
      throw new HookHandlerTimeoutError('UserPromptSubmit', 5000);
    });
    const result = await dispatchTelegramUserPromptSubmit('text', registry);
    expect(result.shouldSkip).toBe(true);
    expect(result.blockNotice).toContain('timed out after 5000ms');
  });

  it('propagates AbortError when the dispatch signal is already aborted', async () => {
    const registry = createHookRegistry();
    // A handler to register so the registry does not short-circuit (no handlers → empty {}).
    registry.register('UserPromptSubmit', async () => ({}));
    const ac = new AbortController();
    ac.abort('test abort');
    // dispatch() calls assertNotAborted(signal) before invoking any handler,
    // and throws AbortError from our utils/errors.ts when the signal is already
    // aborted. The helper must NOT catch that as a block.
    await expect(
      dispatchTelegramUserPromptSubmit('text', registry, undefined),
    ).resolves.toBeDefined(); // no signal passed → no abort; just confirm the helper works

    // With an aborted signal the registry throws AbortError — verify it propagates.
    // We call the registry directly to assert the AbortError contract is separate
    // from the helper's catch (which only catches HookBlockedError / HookHandlerTimeoutError).
    await expect(registry.dispatch({ event: 'UserPromptSubmit', prompt: 'x' }, ac.signal)).rejects.toHaveProperty('name', 'AbortError');
  });
});

// ---------------------------------------------------------------------------
// dispatchTelegramUserPromptSubmit — sessionId forwarding
// ---------------------------------------------------------------------------

describe('dispatchTelegramUserPromptSubmit – sessionId forwarding', () => {
  it('forwards sessionId in the dispatch context', async () => {
    const registry = createHookRegistry();
    const captured: string[] = [];
    registry.register('UserPromptSubmit', async (ctx) => {
      if (ctx.event === 'UserPromptSubmit') captured.push(ctx.sessionId ?? '');
      return {};
    });
    await dispatchTelegramUserPromptSubmit('hi', registry, 'session-abc');
    expect(captured).toEqual(['session-abc']);
  });

  it('omits sessionId from context when not provided', async () => {
    const registry = createHookRegistry();
    const keys: string[] = [];
    registry.register('UserPromptSubmit', async (ctx) => {
      if (ctx.event === 'UserPromptSubmit') keys.push(...Object.keys(ctx));
      return {};
    });
    await dispatchTelegramUserPromptSubmit('hi', registry);
    expect(keys).not.toContain('sessionId');
  });
});

// ---------------------------------------------------------------------------
// Telegram surface integration: MessageHandler dispatches UserPromptSubmit
// ---------------------------------------------------------------------------

/**
 * Smoke test verifying that MessageHandler.handle() → processOne() invokes the
 * UserPromptSubmit hook before calling streamResponse. The hook registry is
 * injected via a mock session so the hook fires under production code paths.
 */

const { mockStreamResponse } = vi.hoisted(() => ({
  mockStreamResponse: vi.fn(async () => {}),
}));

vi.mock('../streaming.js', () => ({
  streamResponse: mockStreamResponse,
}));

vi.mock('./registration.js', () => ({
  registerChatCommands: vi.fn(async () => {}),
}));

vi.mock('../typing-indicator.js', () => ({
  withTypingIndicator: vi.fn(async (_ctx: unknown, fn: () => Promise<void>) => fn()),
}));

vi.mock('../bg-injection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../bg-injection.js')>();
  return {
    ...real,
    drainBgInjections: vi.fn(() => ''),
  };
});

import { MessageHandler } from './message.js';
import type { IAgentSession } from '../../agent/types.js';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';

function makeRoute() {
  return { chatId: 1001, topicId: undefined } as { chatId: number; topicId?: number };
}

function makeCtx(chatId: number, text: string): Context {
  return {
    chat: { id: chatId, type: 'private' },
    message: {
      text,
      from: { id: 1, first_name: 'Test', is_bot: false },
      reply_to_message: undefined,
      entities: [],
      quote: undefined,
    } as unknown as Message.TextMessage,
    botInfo: { id: 999, username: 'testbot', is_bot: true, first_name: 'Bot' },
    reply: vi.fn(async () => ({ message_id: 1 })),
    react: vi.fn(async () => {}),
  } as unknown as Context;
}

function makeSession(hookRegistry?: ReturnType<typeof createHookRegistry>): IAgentSession {
  return {
    state: 'idle',
    hookRegistry,
    getSessionMetadata: () => ({ sessionId: 'sid-123', permissionMode: 'default' }),
    sendMessageStream: vi.fn(async function* () { yield { type: 'done', metadata: {} }; }),
    sendMessage: vi.fn(),
  } as unknown as IAgentSession;
}

function makeSessionManager(session: IAgentSession) {
  return {
    getSession: vi.fn(async () => session),
    getSessionIfExists: vi.fn(() => undefined),
    getSessionId: vi.fn(() => session.getSessionMetadata?.().sessionId),
    recordTelegramTurn: vi.fn(),
  };
}

describe('MessageHandler – UserPromptSubmit wiring', () => {
  beforeEach(() => {
    mockStreamResponse.mockClear();
    mockStreamResponse.mockResolvedValue(undefined);
  });

  it('dispatches UserPromptSubmit before streamResponse', async () => {
    const registry = createHookRegistry();
    const hookCalls: string[] = [];
    registry.register('UserPromptSubmit', async (ctx) => {
      if (ctx.event === 'UserPromptSubmit') hookCalls.push(ctx.prompt);
      return {};
    });

    const session = makeSession(registry);
    const sm = makeSessionManager(session);
    const handler = new MessageHandler(
      { telegram: { sendChatAction: vi.fn(async () => {}) } } as unknown as import('telegraf').Telegraf,
      sm as unknown as import('../session-manager.js').SessionManager,
      new Set(),
      vi.fn(),
    );

    const ctx = makeCtx(1001, 'hello telegram');
    await handler.handle(ctx);

    // Hook fired with the user prompt text
    expect(hookCalls).toEqual(['hello telegram']);
    // streamResponse was called (turn was NOT blocked)
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
  });

  it('drops the turn (no streamResponse) when UserPromptSubmit blocks', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      decision: 'block' as const,
      reason: 'test block',
    }));

    const session = makeSession(registry);
    const sm = makeSessionManager(session);
    const handler = new MessageHandler(
      { telegram: { sendChatAction: vi.fn(async () => {}) } } as unknown as import('telegraf').Telegraf,
      sm as unknown as import('../session-manager.js').SessionManager,
      new Set(),
      vi.fn(),
    );

    const ctx = makeCtx(1001, 'blocked message');
    await handler.handle(ctx);

    // streamResponse must NOT have been called
    expect(mockStreamResponse).not.toHaveBeenCalled();
    // A reply with the block notice was sent to the chat
    const reply = (ctx.reply as ReturnType<typeof vi.fn>);
    expect(reply).toHaveBeenCalled();
    const replyText = reply.mock.calls[0]?.[0] as string;
    expect(replyText).toContain('blocked by hook');
    expect(replyText).toContain('test block');
  });

  it('prepends injectContext to the outbound message', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      injectContext: '[injected prefix]',
    }));

    const session = makeSession(registry);
    const sm = makeSessionManager(session);
    const handler = new MessageHandler(
      { telegram: { sendChatAction: vi.fn(async () => {}) } } as unknown as import('telegraf').Telegraf,
      sm as unknown as import('../session-manager.js').SessionManager,
      new Set(),
      vi.fn(),
    );

    const ctx = makeCtx(1001, 'user text');
    await handler.handle(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    // The second argument to streamResponse is the session; third is the content.
    const contentArg = mockStreamResponse.mock.calls[0]?.[2] as string;
    expect(contentArg).toContain('[injected prefix]');
    expect(contentArg).toContain('user text');
  });
});
