/**
 * Wire-through tests: per-message sender attribution in MessageHandler.
 *
 * The pure `[from …]:` marker logic is unit-tested in sender-attribution.test.ts.
 * Here we assert it is actually threaded into the content handed to
 * streamResponse by handle() (text) and handlePhoto() (photo), applied on the
 * queued/busy path too, and a byte-identical no-op in private chats.
 *
 * Harness mirrors message-tag-only.test.ts / message-photo.test.ts: streamResponse
 * and registerChatCommands are mocked; the content argument is read off
 * mockStreamResponse.mock.calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'telegraf';
import type { Message, PhotoSize } from 'telegraf/types';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

const { mockStreamResponse } = vi.hoisted(() => ({
  mockStreamResponse: vi.fn<
    [Context, unknown, string | ContentBlockParam[], ...unknown[]],
    Promise<void>
  >(async () => { /* no-op */ }),
}));

vi.mock('../streaming.js', () => ({ streamResponse: mockStreamResponse }));
vi.mock('./registration.js', () => ({ registerChatCommands: vi.fn(async () => { /* no-op */ }) }));

import { MessageHandler } from './message.js';

type ChatType = 'private' | 'group' | 'supergroup';
interface Sender { id?: number; first_name?: string; last_name?: string; username?: string }

function makeHandler(sessionState: 'idle' | 'streaming' = 'idle'): MessageHandler {
  const sessionManager = {
    getSession: vi.fn().mockResolvedValue({ state: sessionState }),
    getSessionIfExists: vi.fn().mockReturnValue(undefined),
    resetSession: vi.fn(),
  };
  const bot = { telegram: { sendMessage: vi.fn() }, command: vi.fn(), on: vi.fn() };
  return new MessageHandler(
    bot as unknown as import('telegraf').Telegraf,
    sessionManager as unknown as import('../session-manager.js').SessionManager,
    new Set<number>(),
    vi.fn(),
    new Set<number>(), // no tag-only chats — every message proceeds
  );
}

function makeTextCtx(opts: { chatId: number; text: string; type: ChatType; from?: Sender }): Context {
  const message = { text: opts.text, ...(opts.from ? { from: opts.from } : {}) } as Partial<Message.TextMessage>;
  return {
    chat: { id: opts.chatId, type: opts.type },
    message,
    botInfo: { id: 42, username: 'Bot' },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
  } as unknown as Context;
}

function makePhotoCtx(opts: { chatId: number; caption?: string; type: ChatType; from?: Sender }): Context {
  const photo: PhotoSize[] = [
    { file_id: 'small', file_unique_id: 'u1', width: 90, height: 67, file_size: 100 },
    { file_id: 'large', file_unique_id: 'u3', width: 1280, height: 960, file_size: 9999 },
  ];
  // Mirror message-photo.test.ts: stub fetch to return a small JPEG (recognized
  // content-type → no magic-byte sniffing needed).
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0x00]), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  })));
  const message = {
    photo,
    caption: opts.caption,
    ...(opts.from ? { from: opts.from } : {}),
  } as Partial<Message.PhotoMessage>;
  return {
    chat: { id: opts.chatId, type: opts.type },
    message,
    botInfo: { id: 42, username: 'Bot' },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => ({ message_id: 1 })),
    sendChatAction: vi.fn(async () => true),
    telegram: {
      getFileLink: vi.fn(async () => new URL('https://api.telegram.org/file/bot-token/photos/p.jpg')),
      editMessageText: vi.fn(async () => true),
    },
  } as unknown as Context;
}

describe('sender attribution — text (handle)', () => {
  beforeEach(() => { mockStreamResponse.mockClear(); });

  it('prefixes a group message with the sanitized sender marker', async () => {
    const handler = makeHandler('idle');
    await handler.handle(makeTextCtx({
      chatId: -100, text: 'when is standup?', type: 'group',
      from: { id: 7, first_name: 'Alice', username: 'alice' },
    }));
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    expect(content).toBe('[from Alice @alice (id 7)]: when is standup?');
  });

  it('attributes in a supergroup too', async () => {
    const handler = makeHandler('idle');
    await handler.handle(makeTextCtx({
      chatId: -100, text: 'hi', type: 'supergroup', from: { id: 9, first_name: 'Bob' },
    }));
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    expect(content).toBe('[from Bob (id 9)]: hi');
  });

  it('leaves a private (1:1) message byte-identical (no attribution)', async () => {
    const handler = makeHandler('idle');
    await handler.handle(makeTextCtx({
      chatId: 500, text: 'hi', type: 'private', from: { id: 7, first_name: 'Alice' },
    }));
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    expect(content).toBe('hi');
  });

  it('applies attribution on the queued (busy) path too', async () => {
    const handler = makeHandler('streaming'); // non-idle → enqueue instead of stream
    await handler.handle(makeTextCtx({
      chatId: -100, text: 'hi', type: 'group', from: { id: 7, first_name: 'Alice' },
    }));
    const queues = (handler as unknown as {
      messageQueues: Map<number, Array<{ type: string; text?: string }>>;
    }).messageQueues;
    expect(queues.get(-100)?.[0]?.text).toBe('[from Alice (id 7)]: hi');
    expect(mockStreamResponse).not.toHaveBeenCalled();
  });
});

describe('sender attribution — photo (handlePhoto)', () => {
  beforeEach(() => { mockStreamResponse.mockClear(); vi.unstubAllGlobals(); });

  it('prefixes the caption block with the sender marker in a group', async () => {
    const handler = makeHandler('idle');
    await handler.handlePhoto(makePhotoCtx({
      chatId: -100, caption: 'look at this', type: 'group',
      from: { id: 7, first_name: 'Bob', username: 'bob' },
    }));
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    const blocks = content as ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: 'text', text: '[from Bob @bob (id 7)]: [User caption]: look at this' });
    expect(blocks[1]).toMatchObject({ type: 'image' });
  });

  it('adds a sender-only text block for a captionless group photo', async () => {
    const handler = makeHandler('idle');
    await handler.handlePhoto(makePhotoCtx({
      chatId: -100, caption: undefined, type: 'group', from: { id: 7, first_name: 'Bob' },
    }));
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    const blocks = content as ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: 'text', text: '[from Bob (id 7)]: (image, no caption)' });
    expect(blocks[1]).toMatchObject({ type: 'image' });
  });

  it('leaves a private captionless photo as image-only (no attribution block)', async () => {
    const handler = makeHandler('idle');
    await handler.handlePhoto(makePhotoCtx({
      chatId: 500, caption: undefined, type: 'private', from: { id: 7, first_name: 'Bob' },
    }));
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    const blocks = content as ContentBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image' });
  });
});
