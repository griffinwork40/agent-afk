/**
 * Tests for src/telegram/handlers/document.ts
 *
 * The unit under test is handleDocumentMessage(), which accepts a Telegraf
 * Context and a log function, downloads the document, classifies it, and
 * returns a ContentBlockParam[] or null.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDocumentMessage } from '../../../src/telegram/handlers/document.js';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a minimal Telegraf Context for a document message. */
function makeCtx(opts: {
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  caption?: string;
  fileUrl?: string;
  fetchBytes?: Buffer;
  fetchStatus?: number;
  getFileLinkThrow?: Error;
  fetchThrow?: Error;
}): Context {
  const {
    fileId = 'file123',
    fileName = 'test.txt',
    mimeType = 'text/plain',
    fileSize,
    caption,
    fileUrl = 'https://api.telegram.org/file/botTOKEN/test.txt',
    fetchBytes = Buffer.from('hello world'),
    fetchStatus = 200,
    getFileLinkThrow,
    fetchThrow,
  } = opts;

  const document: Partial<Message.DocumentMessage['document']> = {
    file_id: fileId,
    file_name: fileName,
    mime_type: mimeType,
  };
  if (fileSize !== undefined) document.file_size = fileSize;

  const message: Partial<Message.DocumentMessage> = {
    document: document as Message.DocumentMessage['document'],
  };
  if (caption !== undefined) message.caption = caption;

  const reply = vi.fn().mockResolvedValue({ message_id: 1 });
  const getFileLink = getFileLinkThrow
    ? vi.fn().mockRejectedValue(getFileLinkThrow)
    : vi.fn().mockResolvedValue(new URL(fileUrl));

  // Fake global fetch
  const fakeResponse = {
    ok: fetchStatus >= 200 && fetchStatus < 300,
    status: fetchStatus,
    headers: {
      get: (name: string) => {
        if (name === 'content-length') return String(fetchBytes.byteLength);
        if (name === 'content-type') return mimeType;
        return null;
      },
    },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (!sent) {
              sent = true;
              return { done: false, value: new Uint8Array(fetchBytes) };
            }
            return { done: true, value: undefined };
          },
          releaseLock: () => {},
          cancel: async () => {},
        };
      },
    },
  };

  vi.stubGlobal(
    'fetch',
    fetchThrow
      ? vi.fn().mockRejectedValue(fetchThrow)
      : vi.fn().mockResolvedValue(fakeResponse),
  );

  return {
    chat: { id: 1234, type: 'private' as const },
    message: message as Message.DocumentMessage,
    reply,
    telegram: { getFileLink } as unknown as Context['telegram'],
  } as unknown as Context;
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleDocumentMessage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when ctx.message is missing', async () => {
    const ctx = { chat: { id: 1 }, message: undefined, reply: vi.fn(), telegram: {} } as unknown as Context;
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).toBeNull();
  });

  it('returns null when document field is missing', async () => {
    const ctx = {
      chat: { id: 1 },
      message: { text: 'hello' },
      reply: vi.fn(),
      telegram: {},
    } as unknown as Context;
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).toBeNull();
  });

  it('rejects oversized documents and replies with error', async () => {
    const ctx = makeCtx({ fileSize: 6 * 1024 * 1024 }); // 6 MB > 5 MB cap
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });

  it('rejects unsupported MIME types and replies with helpful message', async () => {
    const ctx = makeCtx({ mimeType: 'video/mp4', fileName: 'video.mp4' });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unsupported'));
  });

  it('returns text document block for a plain text file', async () => {
    const content = 'Hello, world!';
    const ctx = makeCtx({
      mimeType: 'text/plain',
      fileName: 'hello.txt',
      fetchBytes: Buffer.from(content),
    });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    const block = result![0]!;
    expect(block.type).toBe('document');
    if (block.type === 'document') {
      expect(block.source.type).toBe('text');
      if (block.source.type === 'text') {
        expect(block.source.data).toBe(content);
        expect(block.source.media_type).toBe('text/plain');
      }
      expect(block.title).toContain('hello.txt');
    }
  });

  it('returns text document block for a .ts file (extension fallback)', async () => {
    // TypeScript files often get sent as application/octet-stream — classify by extension
    const ctx = makeCtx({
      mimeType: 'application/octet-stream',
      fileName: 'index.ts',
      fetchBytes: Buffer.from('export const x = 1;'),
    });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).not.toBeNull();
    const block = result![0]!;
    expect(block.type).toBe('document');
    if (block.type === 'document') {
      expect(block.source.type).toBe('text');
    }
  });

  it('returns a base64 document block for a PDF file', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf content');
    const ctx = makeCtx({
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      fetchBytes: pdfBytes,
    });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    const block = result![0]!;
    expect(block.type).toBe('document');
    if (block.type === 'document') {
      expect(block.source.type).toBe('base64');
      if (block.source.type === 'base64') {
        expect(block.source.media_type).toBe('application/pdf');
        expect(block.source.data).toBe(pdfBytes.toString('base64'));
      }
    }
  });

  it('prepends caption as a text block when present', async () => {
    const ctx = makeCtx({
      mimeType: 'text/plain',
      fileName: 'notes.txt',
      caption: 'My important notes',
      fetchBytes: Buffer.from('note content'),
    });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    const captionBlock = result![0]!;
    expect(captionBlock.type).toBe('text');
    if (captionBlock.type === 'text') {
      expect(captionBlock.text).toContain('My important notes');
    }
    expect(result![1]!.type).toBe('document');
  });

  it('caps caption at 1024 unicode code points', async () => {
    const longCaption = '🎉'.repeat(2000); // emoji = 2 code units but 1 code point
    const ctx = makeCtx({
      mimeType: 'text/plain',
      fileName: 'f.txt',
      caption: longCaption,
      fetchBytes: Buffer.from('x'),
    });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).not.toBeNull();
    const captionBlock = result![0]!;
    if (captionBlock.type === 'text') {
      // The capped text must not exceed 1024 emoji + "[User caption]: " prefix
      const textWithoutPrefix = captionBlock.text.replace('[User caption]: ', '');
      expect([...textWithoutPrefix].length).toBeLessThanOrEqual(1024);
    }
  });

  it('returns null and replies on fetch failure', async () => {
    const ctx = makeCtx({ fetchThrow: new Error('Connection refused') });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Couldn't download"));
  });

  it('returns null and replies when HTTP status is not OK', async () => {
    const ctx = makeCtx({ fetchStatus: 404 });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Couldn't download"));
  });

  it('redacts bot token from error messages', async () => {
    const tokenError = new Error('fetch failed: https://api.telegram.org/file/botSECRET_TOKEN/path');
    const ctx = makeCtx({ fetchThrow: tokenError });
    const logLines: string[] = [];
    const captureLog = (...args: unknown[]) => logLines.push(args.join(' '));

    await handleDocumentMessage(ctx, captureLog);

    const logged = logLines.join('\n');
    expect(logged).not.toContain('SECRET_TOKEN');
    expect(logged).toContain('[REDACTED]');
  });

  it('rejects a file URL that is not api.telegram.org', async () => {
    const ctx = makeCtx({ fileUrl: 'https://evil.example.com/file/botTOKEN/path' });
    const result = await handleDocumentMessage(ctx, noop);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Couldn't download"));
  });

  it('accepts code file extensions classified as text (json, py, go)', async () => {
    for (const ext of ['json', 'py', 'go']) {
      vi.restoreAllMocks();
      const ctx = makeCtx({
        mimeType: 'application/octet-stream',
        fileName: `file.${ext}`,
        fetchBytes: Buffer.from('content'),
      });
      const result = await handleDocumentMessage(ctx, noop);
      expect(result, `${ext} should be accepted as text`).not.toBeNull();
      expect(result![result!.length - 1]!.type).toBe('document');
    }
  });
});
