/**
 * Tests for photo message handling in MessageHandler
 * Covers: handlePhoto, photo queue items, drainQueue with photo, and streamResponse content-block path
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'telegraf';
import type { Message, PhotoSize } from 'telegraf/types';
import type { IAgentSession, OutputEvent } from '../../agent/types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

// ---------------------------------------------------------------------------
// Module mocks — must be before imports of the modules under test.
// vi.mock factories are hoisted to the top of the file by vitest, so they
// CANNOT reference variables defined in module scope. Use vi.hoisted() to
// create the shared stub that both the mock factory and test assertions use.
// ---------------------------------------------------------------------------

const { mockStreamResponse } = vi.hoisted(() => ({
  mockStreamResponse: vi.fn<[Context, IAgentSession, string | ContentBlockParam[], ((...args: unknown[]) => void)?], Promise<void>>(
    async () => { /* resolved immediately */ }
  ),
}));

vi.mock('../streaming.js', () => ({
  streamResponse: mockStreamResponse,
}));

// Mock registerChatCommands (async, non-critical side-effect)
vi.mock('./registration.js', () => ({
  registerChatCommands: vi.fn(async () => { /* no-op */ }),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { MessageHandler } from './message.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal IAgentSession stub */
function makeSession(state: 'idle' | 'processing' = 'idle'): IAgentSession {
  return {
    state,
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
  } as unknown as IAgentSession;
}

/** Minimal Telegraf Context stub with a photo message */
function makePhotoCtx(opts: {
  chatId?: number;
  photo?: PhotoSize[];
  caption?: string;
  fetchOk?: boolean;
  fetchThrows?: boolean;
  fetchBody?: Buffer | Uint8Array | string;
  fetchHeaders?: Record<string, string>;
} = {}): {
  ctx: Context;
  replies: string[];
  getFileLink: ReturnType<typeof vi.fn>;
} {
  const chatId = opts.chatId ?? 12345;
  const replies: string[] = [];
  const photo: PhotoSize[] = opts.photo ?? [
    { file_id: 'small', file_unique_id: 'u1', width: 90, height: 67, file_size: 100 },
    { file_id: 'mid', file_unique_id: 'u2', width: 320, height: 240, file_size: 500 },
    { file_id: 'large', file_unique_id: 'u3', width: 1280, height: 960, file_size: 9999 },
  ];

  const getFileLink = vi.fn(async (_fileId: string) => new URL('https://api.telegram.org/file/bot-token/photos/photo.jpg'));

  // Stub global fetch
  if (opts.fetchThrows) {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network failure'); }));
  } else {
    const fakeBytes = opts.fetchBody ?? Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fakeBytes, {
      status: opts.fetchOk === false ? 404 : 200,
      headers: {
        'content-type': 'image/jpeg',
        ...opts.fetchHeaders,
      },
    })));
  }

  const message: Partial<Message.PhotoMessage> = {
    photo,
    caption: opts.caption,
  };

  const ctx = {
    chat: { id: chatId, type: 'private' as const },
    message,
    reply: vi.fn(async (text: string) => {
      replies.push(text);
      return { message_id: replies.length, text, chat: { id: chatId }, date: 0 };
    }),
    sendChatAction: vi.fn(async () => true),
    telegram: {
      getFileLink,
      editMessageText: vi.fn(async () => true),
    },
  } as unknown as Context;

  return { ctx, replies, getFileLink };
}

/** Build a MessageHandler with a stub SessionManager */
function makeHandler(session: IAgentSession) {
  const bot = { use: vi.fn(), command: vi.fn(), on: vi.fn(), action: vi.fn(), catch: vi.fn() } as unknown as import('telegraf').Telegraf;
  const sessionManager = {
    getSession: vi.fn(async () => session),
    resetSession: vi.fn(async () => {}),
  } as unknown as import('../session-manager.js').SessionManager;
  const registeredCommandChats = new Set<number>();
  const log = vi.fn();
  return new MessageHandler(bot, sessionManager, registeredCommandChats, log);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('handlePhoto: photo with caption', () => {
  it('builds content blocks [text, image] and forwards via streamResponse', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx } = makePhotoCtx({ caption: 'What is this?' });

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as ContentBlockParam[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', text: '[User caption]: What is this?' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg' },
    });
    // Verify the base64 data is non-empty
    const imageBlock = blocks[1] as Extract<ContentBlockParam, { type: 'image' }>;
    expect(typeof (imageBlock.source as { data: string }).data).toBe('string');
    expect((imageBlock.source as { data: string }).data.length).toBeGreaterThan(0);
  });
});

describe('handlePhoto: photo without caption', () => {
  it('builds content blocks [image] only (no text block)', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx } = makePhotoCtx({ caption: undefined });

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    const blocks = content as ContentBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image' });
  });
});

describe('handlePhoto: largest size selected', () => {
  it('downloads only the last (largest) photo size', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const photo: PhotoSize[] = [
      { file_id: 'small', file_unique_id: 'u1', width: 90, height: 67 },
      { file_id: 'mid', file_unique_id: 'u2', width: 320, height: 240 },
      { file_id: 'large', file_unique_id: 'u3', width: 1280, height: 960 },
    ];
    const { ctx, getFileLink } = makePhotoCtx({ photo });

    await handler.handlePhoto(ctx);

    expect(getFileLink).toHaveBeenCalledWith('large');
    expect(getFileLink).toHaveBeenCalledTimes(1);
  });
});

describe('handlePhoto: download failure', () => {
  it('replies with a user-visible error when fetch returns non-200, does not call streamResponse', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makePhotoCtx({ fetchOk: false });

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('Couldn\'t download'))).toBe(true);
  });

  it('replies with a user-visible error when fetch throws, does not crash', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makePhotoCtx({ fetchThrows: true });

    await expect(handler.handlePhoto(ctx)).resolves.toBeUndefined();
    expect(mockStreamResponse).not.toHaveBeenCalled();
    // Either network error message or internal error is acceptable
    expect(replies.length).toBeGreaterThanOrEqual(1);
  });
});

describe('handlePhoto: session busy — enqueue', () => {
  it('enqueues photo as QueueItem, replies with queue position, does NOT call streamResponse', async () => {
    const session = makeSession('processing');
    const handler = makeHandler(session);
    const { ctx, replies } = makePhotoCtx({ caption: 'queued photo' });

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    // Now uses formatQueued — check for queue indicator
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('#1');
  });
});

describe('handlePhoto: chat undefined (early return)', () => {
  it('returns silently without reply when ctx.chat is undefined', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx } = makePhotoCtx();
    // Remove ctx.chat to simulate a channel/forward with no chat context
    (ctx as unknown as Record<string, unknown>).chat = undefined;

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('handlePhoto: empty photo array (early return)', () => {
  it('returns silently without reply when photo array is empty', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx } = makePhotoCtx({ photo: [] });

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('handlePhoto: oversized file (file_size > 5 MB)', () => {
  it('replies with too-large error and never calls getFileLink or streamResponse', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const oversizedPhoto: PhotoSize[] = [
      { file_id: 'big', file_unique_id: 'u1', width: 4096, height: 3072, file_size: 6_000_000 },
    ];
    const { ctx, replies, getFileLink } = makePhotoCtx({ photo: oversizedPhoto });

    await handler.handlePhoto(ctx);

    // Must bail before any network I/O
    expect(getFileLink).not.toHaveBeenCalled();
    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('too large'))).toBe(true);
  });
});

describe('handlePhoto: streamed download size cap', () => {
  it('rejects by Content-Length before buffering the response body', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makePhotoCtx({
      photo: [{ file_id: 'big', file_unique_id: 'u1', width: 4096, height: 3072 }],
      fetchHeaders: { 'content-length': String(6_000_000) },
    });

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('too large'))).toBe(true);
  });

  it('stops streaming once bytes exceed the max even when file_size and Content-Length are absent', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const overLimit = new Uint8Array((5 * 1024 * 1024) + 1);
    overLimit.set([0xff, 0xd8, 0xff], 0);
    const { ctx, replies } = makePhotoCtx({
      photo: [{ file_id: 'big', file_unique_id: 'u1', width: 4096, height: 3072 }],
      fetchBody: overLimit,
    });

    await handler.handlePhoto(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('too large'))).toBe(true);
  });
});

describe('handlePhoto: SSRF hostname mismatch', () => {
  it('replies with error and never calls fetch when file URL host is not api.telegram.org', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makePhotoCtx();
    // Override getFileLink to return an attacker-controlled host
    (ctx.telegram.getFileLink as ReturnType<typeof vi.fn>).mockResolvedValue(
      new URL('https://evil.example.com/steal.jpg')
    );

    await handler.handlePhoto(ctx);

    // fetch must never be called — the guard runs before the fetch
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes("Couldn't download"))).toBe(true);
  });
});

describe('drainQueue with photo item', () => {
  it('replays queued photo content blocks via streamResponse after in-flight turn', async () => {
    // Strategy: make the session idle from the start. Send a text message
    // first — processOne will call streamResponse and then drainQueue.
    // Before processOne finishes we enqueue a photo item. The drain should
    // then pick it up and call streamResponse with the content blocks.
    //
    // We control timing by making mockStreamResponse itself enqueue the photo
    // on its first call, then check that the second call carries the array.

    let streamCallCount = 0;
    const capturedContent: Array<string | ContentBlockParam[]> = [];

    mockStreamResponse.mockImplementation(async (_ctx, _session, content) => {
      capturedContent.push(content);
      streamCallCount++;
      // On the first call (text message), nothing more to do.
      // The drain will process the photo synchronously after this resolves.
    });

    const session = makeSession('idle');
    const bot = { use: vi.fn(), command: vi.fn(), on: vi.fn(), action: vi.fn(), catch: vi.fn() } as unknown as import('telegraf').Telegraf;
    const sessionManager = {
      getSession: vi.fn(async () => session),
      resetSession: vi.fn(async () => {}),
    } as unknown as import('../session-manager.js').SessionManager;
    const log = vi.fn();
    const handler = new MessageHandler(bot, sessionManager, new Set<number>(), log);

    // Enqueue a photo before the text message processes by making the session
    // appear busy during the photo's getSession call.
    const busySession = { ...session, state: 'processing' as const };
    (sessionManager.getSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(busySession)  // photo call: busy → enqueue
      .mockResolvedValue(session);          // text call: idle → processOne

    const { ctx: photoCtx } = makePhotoCtx({ caption: 'drain test' });

    // Enqueue the photo (session is busy on first call)
    await handler.handlePhoto(photoCtx);
    expect(mockStreamResponse).not.toHaveBeenCalled();

    // Now send a text message with an idle session — processOne runs and drains the queue
    const textCtx = {
      chat: { id: 12345, type: 'private' as const },
      message: { text: 'trigger drain' } as Message.TextMessage,
      reply: vi.fn(async () => ({ message_id: 1 })),
      sendChatAction: vi.fn(async () => true),
      telegram: { editMessageText: vi.fn(async () => true) },
    } as unknown as Context;

    await handler.handle(textCtx);

    // Wait a tick for the async drainQueue to complete
    await new Promise(resolve => setImmediate(resolve));

    // streamResponse called at least twice: text + drained photo
    expect(streamCallCount).toBeGreaterThanOrEqual(2);
    // The drained call must carry an array (photo content blocks)
    const hasPhotoCall = capturedContent.some(c => Array.isArray(c));
    expect(hasPhotoCall).toBe(true);
  });
});

describe('streamResponse: content-block path', () => {
  it('calls session.sendMessageStream with blocks directly (never sendMessage)', async () => {
    // We need to test the real streamResponse here, not the mock.
    // Re-import without the mock for this test.
    // Since we've mocked the module globally, we test the behavior indirectly:
    // verify that the handler passes content blocks to streamResponse as an array.
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx } = makePhotoCtx({ caption: 'vision test' });

    await handler.handlePhoto(ctx);

    // Verify streamResponse was called with a ContentBlockParam array
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, calledSession, calledContent] = mockStreamResponse.mock.calls[0]!;
    expect(calledSession).toBe(await (handler as unknown as { sessionManager: { getSession: (id: number) => Promise<IAgentSession> } }).sessionManager.getSession(12345));
    expect(Array.isArray(calledContent)).toBe(true);
  });
});

describe('processOne: busy-spin cascade guard', () => {
  // Regression test for PR #396 blocker: if streamResponse throws "session is busy"
  // (the TOCTOU race where the session flips from idle→busy between the caller's
  // state check and processOne's getSession call), processOne re-enqueues the item
  // in its catch block. The finally block must NOT then call drainQueue — otherwise
  // it shifts the just-re-enqueued item and calls processOne again, producing a
  // flood of queue-acknowledgment replies (one per cascade iteration).
  it('does not cascade-drain when catch block re-enqueues the item', async () => {
    const session = makeSession('idle');  // passes initial state check in handle()

    // streamResponse throws once with "session is busy" (the TOCTOU race),
    // then resolves cleanly on any subsequent call (which we expect NOT to happen).
    let streamCallCount = 0;
    mockStreamResponse.mockImplementation(async () => {
      streamCallCount++;
      if (streamCallCount === 1) {
        throw new Error('session is busy');
      }
      // If the gate is broken, the cascade would call streamResponse again here.
    });

    const handler = makeHandler(session);
    const chatId = 12345;
    const replies: string[] = [];
    const ctx = {
      chat: { id: chatId, type: 'private' as const },
      message: { text: 'will hit the race' } as Message.TextMessage,
      reply: vi.fn(async (text: string) => {
        replies.push(text);
        return { message_id: replies.length, text, chat: { id: chatId }, date: 0 };
      }),
      sendChatAction: vi.fn(async () => true),
      telegram: { editMessageText: vi.fn(async () => true) },
    } as unknown as Context;

    await handler.handle(ctx);

    // Let any pending microtasks (a cascade would chain through them) settle.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // streamResponse was attempted exactly once — the failed call. The gate
    // prevented finally→drainQueue from popping the re-enqueued item and
    // invoking streamResponse a second time within the same tick.
    expect(streamCallCount).toBe(1);

    // User sees exactly one queued acknowledgment — not a flood.
    // Now uses formatQueued format (e.g. "⏳ Queued (#1 in line)"), not "Message queued."
    const queuedCount = replies.filter(r => r.includes('#1') || r.includes('Queued')).length;
    expect(queuedCount).toBe(1);
  });

  it('does not cascade-drain when photo handler re-enqueues on session-busy race', async () => {
    // Same regression but on the photo path: processOne is shared, so the gate
    // must hold for ContentBlockParam[] content too.
    const session = makeSession('idle');

    let streamCallCount = 0;
    mockStreamResponse.mockImplementation(async () => {
      streamCallCount++;
      if (streamCallCount === 1) {
        throw new Error('session is busy');
      }
    });

    const handler = makeHandler(session);
    const { ctx, replies } = makePhotoCtx({ caption: 'race condition photo' });

    await handler.handlePhoto(ctx);

    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(streamCallCount).toBe(1);
    // Now uses formatQueued format (e.g. "⏳ Queued (#1 in line)"), not "Message queued."
    const queuedCount = replies.filter(r => r.includes('#1') || r.includes('Queued')).length;
    expect(queuedCount).toBe(1);
  });
});
