/**
 * Tests for document message handling in MessageHandler
 * Covers: handleDocument, document queue items, drainQueue with document,
 * text file decoding, PDF passthrough, size-cap rejection, and unsupported formats.
 *
 * Pattern mirrors message-photo.test.ts — see that file for detailed comments
 * on the vi.hoisted / vi.mock ordering constraints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'telegraf';
import type { Message, Document } from 'telegraf/types';
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
    sessionId: 'telegram-test-session',
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

/** Build a MessageHandler with a stub SessionManager */
function makeHandler(session: IAgentSession) {
  const bot = {
    use: vi.fn(), command: vi.fn(), on: vi.fn(), action: vi.fn(), catch: vi.fn(),
  } as unknown as import('telegraf').Telegraf;
  const sessionManager = {
    getSession: vi.fn(async () => session),
    resetSession: vi.fn(async () => {}),
  } as unknown as import('../session-manager.js').SessionManager;
  const registeredCommandChats = new Set<number>();
  const log = vi.fn();
  return new MessageHandler(bot, sessionManager, registeredCommandChats, log);
}

type DocCtxOpts = {
  chatId?: number;
  doc?: Partial<Document>;
  caption?: string;
  fetchOk?: boolean;
  fetchThrows?: boolean;
  fetchBody?: Buffer | Uint8Array | string;
  fetchHeaders?: Record<string, string>;
};

/**
 * Build a Telegraf Context stub for a document update.
 */
function makeDocCtx(opts: DocCtxOpts = {}): {
  ctx: Context;
  replies: string[];
  getFileLink: ReturnType<typeof vi.fn>;
} {
  const chatId = opts.chatId ?? 12345;
  const replies: string[] = [];

  const doc: Document = {
    file_id: 'doc-file-id',
    file_unique_id: 'doc-unique-id',
    file_name: opts.doc?.file_name ?? 'README.md',
    mime_type: opts.doc?.mime_type ?? 'text/markdown',
    file_size: opts.doc?.file_size ?? 1024,
    ...opts.doc,
  };

  const getFileLink = vi.fn(async (_fileId: string) =>
    new URL('https://api.telegram.org/file/bot-token/documents/file.md'),
  );

  const fakeContent = opts.fetchBody ?? Buffer.from('# Hello\n\nworld');

  if (opts.fetchThrows) {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network failure'); }));
  } else {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fakeContent, {
      status: opts.fetchOk === false ? 404 : 200,
      headers: {
        'content-type': doc.mime_type ?? 'text/plain',
        ...opts.fetchHeaders,
      },
    })));
  }

  const message: Partial<Message.DocumentMessage> = {
    document: doc,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Text file handling
// ---------------------------------------------------------------------------

describe('handleDocument: text file (.md)', () => {
  it('calls streamResponse with a text content block containing the file body', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const body = '# My README\n\nSome content here.';
    const { ctx } = makeDocCtx({
      doc: { file_name: 'README.md', mime_type: 'text/markdown', file_size: body.length },
      fetchBody: Buffer.from(body),
    });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as ContentBlockParam[];
    // Should have at least one text block with the file header and body
    const textBlocks = blocks.filter(b => b.type === 'text') as Extract<ContentBlockParam, { type: 'text' }>[];
    const docBlock = textBlocks.find(b => b.text.includes('Document: README.md'));
    expect(docBlock).toBeDefined();
    expect(docBlock!.text).toContain(body);
  });
});

describe('handleDocument: text file with caption', () => {
  it('prepends the caption as a separate text block before the document block', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx } = makeDocCtx({
      doc: { file_name: 'config.json', mime_type: 'application/json', file_size: 20 },
      caption: 'Check this config',
      fetchBody: Buffer.from('{"key":"value"}'),
    });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    const blocks = content as ContentBlockParam[];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    // First block: caption
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('[User caption]: Check this config') });
    // A later block contains the file content
    const fileBlock = blocks.find(b => b.type === 'text' && (b as { type: 'text'; text: string }).text.includes('Document:'));
    expect(fileBlock).toBeDefined();
  });
});

describe('handleDocument: JavaScript file by extension', () => {
  it('recognises .js extension as text even with generic mime type', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx({
      doc: {
        file_name: 'script.js',
        mime_type: 'application/octet-stream', // generic binary mime
        file_size: 30,
      },
      fetchBody: Buffer.from('console.log("hello world");'),
    });

    await handler.handleDocument(ctx);

    // Should NOT show unsupported-format reply
    expect(replies.some(r => r.includes('Unsupported'))).toBe(false);
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    const blocks = content as ContentBlockParam[];
    const docBlock = (blocks as Extract<ContentBlockParam, { type: 'text' }>[]).find(
      b => b.type === 'text' && b.text.includes('Document: script.js'),
    );
    expect(docBlock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PDF handling
// ---------------------------------------------------------------------------

describe('handleDocument: PDF file', () => {
  it('calls streamResponse with a document content block (base64 pdf)', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const fakePdfBytes = Buffer.from('%PDF-1.4 fake pdf bytes');
    const { ctx } = makeDocCtx({
      doc: { file_name: 'report.pdf', mime_type: 'application/pdf', file_size: fakePdfBytes.length },
      fetchBody: fakePdfBytes,
    });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).toHaveBeenCalledTimes(1);
    const [, , content] = mockStreamResponse.mock.calls[0]!;
    const blocks = content as ContentBlockParam[];
    const pdfBlock = blocks.find(b => b.type === 'document') as
      | { type: 'document'; source: { type: string; media_type: string; data: string } }
      | undefined;
    expect(pdfBlock).toBeDefined();
    expect(pdfBlock!.source.type).toBe('base64');
    expect(pdfBlock!.source.media_type).toBe('application/pdf');
    expect(pdfBlock!.source.data).toBe(fakePdfBytes.toString('base64'));
  });
});

// ---------------------------------------------------------------------------
// Size-cap rejection
// ---------------------------------------------------------------------------

describe('handleDocument: oversized file (file_size > 5 MB)', () => {
  it('replies with too-large error and never calls getFileLink or streamResponse', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies, getFileLink } = makeDocCtx({
      doc: { file_name: 'huge.txt', mime_type: 'text/plain', file_size: 6_000_000 },
    });

    await handler.handleDocument(ctx);

    expect(getFileLink).not.toHaveBeenCalled();
    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('too large'))).toBe(true);
  });
});

describe('handleDocument: streamed download size cap (Content-Length)', () => {
  it('rejects by Content-Length before buffering the body', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx({
      doc: { file_name: 'big.txt', mime_type: 'text/plain' },
      fetchHeaders: { 'content-length': String(6_000_000) },
    });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('too large'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported binary format
// ---------------------------------------------------------------------------

describe('handleDocument: unsupported binary format', () => {
  it('replies with unsupported-format message and never calls streamResponse', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx({
      doc: { file_name: 'archive.zip', mime_type: 'application/zip', file_size: 1024 },
    });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('Unsupported file type'))).toBe(true);
  });

  it('rejects .exe files', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx({
      doc: { file_name: 'setup.exe', mime_type: 'application/x-msdownload', file_size: 1024 },
    });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes('Unsupported file type'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Download failure
// ---------------------------------------------------------------------------

describe('handleDocument: download failure', () => {
  it('replies with error when fetch returns non-200', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx({
      doc: { file_name: 'notes.txt', mime_type: 'text/plain', file_size: 100 },
      fetchOk: false,
    });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes("Couldn't download"))).toBe(true);
  });

  it('replies with error when fetch throws, does not crash', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx({
      doc: { file_name: 'notes.txt', mime_type: 'text/plain', file_size: 100 },
      fetchThrows: true,
    });

    await expect(handler.handleDocument(ctx)).resolves.toBeUndefined();
    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Missing context (early return)
// ---------------------------------------------------------------------------

describe('handleDocument: missing chat (early return)', () => {
  it('returns silently when ctx.chat is undefined', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx } = makeDocCtx();
    (ctx as unknown as Record<string, unknown>).chat = undefined;

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session busy — enqueue
// ---------------------------------------------------------------------------

describe('handleDocument: session busy — enqueue', () => {
  it('enqueues document as QueueItem, replies with queue position, does NOT call streamResponse', async () => {
    const session = makeSession('processing');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx({ caption: 'queued doc' });

    await handler.handleDocument(ctx);

    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('#1');
  });
});

// ---------------------------------------------------------------------------
// drainQueue with document item
// ---------------------------------------------------------------------------

describe('drainQueue with document item', () => {
  it('replays queued document content blocks via streamResponse after in-flight turn', async () => {
    let streamCallCount = 0;
    const capturedContent: Array<string | ContentBlockParam[]> = [];

    mockStreamResponse.mockImplementation(async (_ctx, _session, content) => {
      capturedContent.push(content);
      streamCallCount++;
    });

    const session = makeSession('idle');
    const bot = {
      use: vi.fn(), command: vi.fn(), on: vi.fn(), action: vi.fn(), catch: vi.fn(),
    } as unknown as import('telegraf').Telegraf;
    const sessionManager = {
      getSession: vi.fn(async () => session),
      resetSession: vi.fn(async () => {}),
    } as unknown as import('../session-manager.js').SessionManager;
    const log = vi.fn();
    const handler = new MessageHandler(bot, sessionManager, new Set<number>(), log);

    // First call: busy → enqueue the document
    const busySession = { ...session, state: 'processing' as const };
    (sessionManager.getSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(busySession)
      .mockResolvedValue(session);

    const { ctx: docCtx } = makeDocCtx({ caption: 'drain test doc' });
    await handler.handleDocument(docCtx);
    expect(mockStreamResponse).not.toHaveBeenCalled();

    // Now send a text message that triggers the drain
    const textCtx = {
      chat: { id: 12345, type: 'private' as const },
      message: { text: 'trigger drain' } as Message.TextMessage,
      reply: vi.fn(async () => ({ message_id: 1 })),
      sendChatAction: vi.fn(async () => true),
      telegram: { editMessageText: vi.fn(async () => true) },
    } as unknown as Context;

    await handler.handle(textCtx);
    await new Promise(resolve => setImmediate(resolve));

    // streamResponse called at least twice: text turn + drained document
    expect(streamCallCount).toBeGreaterThanOrEqual(2);
    // The drained call carries an array (document content blocks)
    const hasDocCall = capturedContent.some(c => Array.isArray(c));
    expect(hasDocCall).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

describe('handleDocument: SSRF hostname mismatch', () => {
  it('replies with error and never calls fetch when file URL host is not api.telegram.org', async () => {
    const session = makeSession('idle');
    const handler = makeHandler(session);
    const { ctx, replies } = makeDocCtx();
    (ctx.telegram.getFileLink as ReturnType<typeof vi.fn>).mockResolvedValue(
      new URL('https://evil.example.com/steal.txt'),
    );

    await handler.handleDocument(ctx);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockStreamResponse).not.toHaveBeenCalled();
    expect(replies.some(r => r.includes("Couldn't download"))).toBe(true);
  });
});
