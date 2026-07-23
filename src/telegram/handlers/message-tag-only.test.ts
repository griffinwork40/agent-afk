/**
 * Tests for the per-chat "tag-only" response policy in MessageHandler.
 *
 * Two layers:
 *   1. The pure `addressedToBot` predicate (reply / @mention / text_mention).
 *   2. The gate wired into handle() (text) and handlePhoto() — an un-addressed
 *      message in a tag-only chat is dropped BEFORE getSession / getFileLink /
 *      any ack, and an addressed message (or a message in a non-tag-only chat)
 *      proceeds exactly as before.
 *
 * Mirrors the harness patterns in message.test.ts / message-photo.test.ts:
 * streamResponse and registerChatCommands are mocked, and the proceed vs. drop
 * decision is read off whether getSession / getFileLink were called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'telegraf';
import type { Message, MessageEntity, PhotoSize } from 'telegraf/types';

// ---------------------------------------------------------------------------
// Module mocks — must be registered before the module under test is imported.
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

import { MessageHandler, addressedToBot } from './message.js';

const BOT_ID = 42;
const BOT_USERNAME = 'MyCoolBot';

// ---------------------------------------------------------------------------
// addressedToBot matrix
// ---------------------------------------------------------------------------

/** Build a `mention` entity spanning the whole `@username` token in `text`. */
function mentionEntity(text: string, needle: string): MessageEntity {
  const offset = text.indexOf(needle);
  return { type: 'mention', offset, length: needle.length } as MessageEntity;
}

function textMentionEntity(offset: number, length: number, userId: number): MessageEntity {
  return {
    type: 'text_mention',
    offset,
    length,
    user: { id: userId, is_bot: true, first_name: 'Bot' },
  } as MessageEntity;
}

describe('addressedToBot', () => {
  it('reply to the bot → true', () => {
    expect(addressedToBot('hello', undefined, BOT_ID, BOT_ID, BOT_USERNAME)).toBe(true);
  });

  it('reply to a different user → false', () => {
    expect(addressedToBot('hello', undefined, 999, BOT_ID, BOT_USERNAME)).toBe(false);
  });

  it('@mention of the bot username → true', () => {
    const text = `hey @${BOT_USERNAME} do the thing`;
    expect(addressedToBot(text, [mentionEntity(text, `@${BOT_USERNAME}`)], undefined, BOT_ID, BOT_USERNAME)).toBe(true);
  });

  it('@mention of a different username → false', () => {
    const text = 'hey @SomeoneElse do the thing';
    expect(addressedToBot(text, [mentionEntity(text, '@SomeoneElse')], undefined, BOT_ID, BOT_USERNAME)).toBe(false);
  });

  it('@mention is case-insensitive → true', () => {
    const text = `yo @${BOT_USERNAME.toLowerCase()} hi`;
    expect(addressedToBot(text, [mentionEntity(text, `@${BOT_USERNAME.toLowerCase()}`)], undefined, BOT_ID, BOT_USERNAME)).toBe(true);
  });

  it('text_mention resolving to the bot id → true', () => {
    const text = 'Bot please help';
    expect(addressedToBot(text, [textMentionEntity(0, 3, BOT_ID)], undefined, BOT_ID, undefined)).toBe(true);
  });

  it('text_mention resolving to a different id → false', () => {
    const text = 'Someone please help';
    expect(addressedToBot(text, [textMentionEntity(0, 7, 999)], undefined, BOT_ID, undefined)).toBe(false);
  });

  it('plain text with no reply and no entities → false', () => {
    expect(addressedToBot('just chatting', undefined, undefined, BOT_ID, BOT_USERNAME)).toBe(false);
    expect(addressedToBot('just chatting', [], undefined, BOT_ID, BOT_USERNAME)).toBe(false);
  });

  it('undefined bot username + a mention entity → false (cannot match)', () => {
    const text = `hey @${BOT_USERNAME} hi`;
    expect(addressedToBot(text, [mentionEntity(text, `@${BOT_USERNAME}`)], undefined, BOT_ID, undefined)).toBe(false);
  });

  it('mention NOT at offset 0 (mid-message) still matches by slice → true', () => {
    const text = `please, @${BOT_USERNAME}, look`;
    const ent = mentionEntity(text, `@${BOT_USERNAME}`);
    expect(ent.offset).toBeGreaterThan(0); // guard: the token is genuinely mid-string
    expect(addressedToBot(text, [ent], undefined, BOT_ID, BOT_USERNAME)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate wiring helpers
// ---------------------------------------------------------------------------

function makeHandler(tagOnlyChats: Set<number>): {
  handler: MessageHandler;
  getSession: ReturnType<typeof vi.fn>;
} {
  const getSession = vi.fn().mockResolvedValue({ state: 'idle' });
  const sessionManager = {
    getSession,
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
    tagOnlyChats,
  );
  return { handler, getSession };
}

function makeTextCtx(opts: {
  chatId: number;
  text: string;
  entities?: MessageEntity[];
  replyFromId?: number;
  botInfo?: { id: number; username?: string } | undefined;
}): { ctx: Context; react: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> } {
  const react = vi.fn(async () => {});
  const reply = vi.fn(async () => {});
  const message: Partial<Message.TextMessage> = {
    text: opts.text,
    entities: opts.entities,
    ...(opts.replyFromId !== undefined
      ? { reply_to_message: { from: { id: opts.replyFromId, is_bot: true, first_name: 'B' } } as Message }
      : {}),
  };
  const ctx = {
    chat: { id: opts.chatId, type: 'group' as const },
    message,
    botInfo: 'botInfo' in opts ? opts.botInfo : { id: BOT_ID, username: BOT_USERNAME },
    react,
    reply,
    sendChatAction: vi.fn(async () => {}),
  } as unknown as Context;
  return { ctx, react, reply };
}

// ---------------------------------------------------------------------------
// Gate — text (handle)
// ---------------------------------------------------------------------------

describe('MessageHandler tag-only gate — text', () => {
  const TAG_CHAT = -100123;
  const NORMAL_CHAT = -100999;

  beforeEach(() => {
    mockStreamResponse.mockClear();
  });

  it('un-addressed message in a tag-only chat is dropped: no getSession, no react, no reply', async () => {
    const { handler, getSession } = makeHandler(new Set([TAG_CHAT]));
    const { ctx, react, reply } = makeTextCtx({ chatId: TAG_CHAT, text: 'idle chatter' });

    await handler.handle(ctx);

    expect(getSession).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(mockStreamResponse).not.toHaveBeenCalled();
  });

  it('addressed message (reply to the bot) in a tag-only chat proceeds', async () => {
    const { handler, getSession } = makeHandler(new Set([TAG_CHAT]));
    const { ctx, react } = makeTextCtx({ chatId: TAG_CHAT, text: 'thanks', replyFromId: BOT_ID });

    await handler.handle(ctx);

    // Proceed signal: the ack fires, getSession is reached, and the message is
    // handed to processOne → streamResponse (the mocked turn). getSession is
    // called more than once on the proceed path (handle() + processOne), so we
    // assert "reached" rather than an exact count.
    expect(react).toHaveBeenCalled();
    expect(getSession).toHaveBeenCalled();
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
  });

  it('addressed message (@mention) in a tag-only chat proceeds', async () => {
    const { handler } = makeHandler(new Set([TAG_CHAT]));
    const text = `@${BOT_USERNAME} status?`;
    const { ctx } = makeTextCtx({ chatId: TAG_CHAT, text, entities: [mentionEntity(text, `@${BOT_USERNAME}`)] });

    await handler.handle(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
  });

  it('un-addressed message in a NON-tag-only chat proceeds (regression)', async () => {
    const { handler } = makeHandler(new Set([TAG_CHAT]));
    const { ctx } = makeTextCtx({ chatId: NORMAL_CHAT, text: 'idle chatter' });

    await handler.handle(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
  });

  it('tag-only chat with botInfo undefined → dropped (fail-closed)', async () => {
    const { handler, getSession } = makeHandler(new Set([TAG_CHAT]));
    // Even a reply that would otherwise be "addressed" is dropped, because the
    // bot identity is unknown and the policy fails closed.
    const { ctx } = makeTextCtx({ chatId: TAG_CHAT, text: 'thanks', replyFromId: BOT_ID, botInfo: undefined });

    await handler.handle(ctx);

    expect(getSession).not.toHaveBeenCalled();
  });

  it('un-addressed message in a tag-only chat with a LIVE pending elicitation is still consumed by the resolver (not dropped)', async () => {
    // Reviewer P2 regression: the pending-elicitation intercept must run BEFORE
    // the tag-only gate, so an answer to an active ask_question elicitation is
    // never silently dropped just because it isn't a reply/@mention. Use the
    // ledger-originated bypass (handler.ledgerOriginatedPendingChats) so the
    // resolver fires regardless of session state — see the field doc on
    // MessageHandler.ledgerOriginatedPendingChats.
    const { handler, getSession } = makeHandler(new Set([TAG_CHAT]));
    const resolved: string[] = [];
    handler.pendingElicitations.set(TAG_CHAT, (text) => resolved.push(text));
    handler.ledgerOriginatedPendingChats.add(TAG_CHAT);

    const { ctx, react } = makeTextCtx({ chatId: TAG_CHAT, text: 'my answer, no mention' });

    await handler.handle(ctx);

    // Resolver fired with the message text — the elicitation answer was consumed.
    expect(resolved).toEqual(['my answer, no mention']);
    // Entry cleaned up on both maps.
    expect(handler.pendingElicitations.has(TAG_CHAT)).toBe(false);
    expect(handler.ledgerOriginatedPendingChats.has(TAG_CHAT)).toBe(false);
    // The message never reached the tag-only gate's drop path or processOne:
    // no ack react, no getSession, no queued turn.
    expect(react).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(mockStreamResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gate — photo (handlePhoto)
// ---------------------------------------------------------------------------

function makePhotoCtx(opts: {
  chatId: number;
  caption?: string;
  captionEntities?: MessageEntity[];
  replyFromId?: number;
  botInfo?: { id: number; username?: string } | undefined;
}): { ctx: Context; getFileLink: ReturnType<typeof vi.fn>; react: ReturnType<typeof vi.fn> } {
  const photo: PhotoSize[] = [
    { file_id: 'small', file_unique_id: 'u1', width: 90, height: 67, file_size: 100 },
    { file_id: 'large', file_unique_id: 'u3', width: 1280, height: 960, file_size: 9999 },
  ];
  const getFileLink = vi.fn(async () => new URL('https://api.telegram.org/file/bot-token/photos/p.jpg'));
  const react = vi.fn(async () => {});
  const message: Partial<Message.PhotoMessage> = {
    photo,
    caption: opts.caption,
    caption_entities: opts.captionEntities,
    ...(opts.replyFromId !== undefined
      ? { reply_to_message: { from: { id: opts.replyFromId, is_bot: true, first_name: 'B' } } as Message }
      : {}),
  };
  const ctx = {
    chat: { id: opts.chatId, type: 'group' as const },
    message,
    botInfo: 'botInfo' in opts ? opts.botInfo : { id: BOT_ID, username: BOT_USERNAME },
    react,
    reply: vi.fn(async () => ({ message_id: 1 })),
    sendChatAction: vi.fn(async () => true),
    telegram: { getFileLink, editMessageText: vi.fn(async () => true) },
  } as unknown as Context;
  return { ctx, getFileLink, react };
}

describe('MessageHandler tag-only gate — photo', () => {
  const TAG_CHAT = -100123;

  it('un-addressed photo in a tag-only chat is dropped before getFileLink and the ack', async () => {
    const { handler } = makeHandler(new Set([TAG_CHAT]));
    const { ctx, getFileLink, react } = makePhotoCtx({ chatId: TAG_CHAT, caption: 'nice pic' });

    await handler.handlePhoto(ctx);

    expect(getFileLink).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });

  it('addressed photo (reply to the bot) in a tag-only chat proceeds to getFileLink', async () => {
    const { handler } = makeHandler(new Set([TAG_CHAT]));
    const { ctx, getFileLink } = makePhotoCtx({ chatId: TAG_CHAT, caption: 'look', replyFromId: BOT_ID });

    await handler.handlePhoto(ctx);

    expect(getFileLink).toHaveBeenCalledTimes(1);
  });

  it('addressed photo (@mention in caption) in a tag-only chat proceeds', async () => {
    const { handler } = makeHandler(new Set([TAG_CHAT]));
    const caption = `@${BOT_USERNAME} what is this`;
    const { ctx, getFileLink } = makePhotoCtx({
      chatId: TAG_CHAT,
      caption,
      captionEntities: [mentionEntity(caption, `@${BOT_USERNAME}`)],
    });

    await handler.handlePhoto(ctx);

    expect(getFileLink).toHaveBeenCalledTimes(1);
  });
});
