/**
 * Document message handler for the Telegram bot.
 * Extracted from message.ts to keep that file within the baselined ceiling.
 * Supports text/code files (decoded as UTF-8 text blocks) and PDFs
 * (passed as base64 document blocks). Unsupported formats receive a helpful
 * rejection message listing accepted types.
 *
 * @module telegram/handlers/document
 */

import { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

// History: extracted from message.ts in PR #687 (document handler).
// message.ts was already at its baselined ceiling, so all document
// logic lives here; message.ts only holds the thin public method
// and queue-type extension.

/** 5 MB — mirrors the photo handler cap. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/**
 * Extensions (without leading dot) that are decoded as UTF-8 text.
 * Checked only when the mime_type is not a text/* variant and not
 * application/pdf — this is the fallback set for mis-typed files.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log',
  'py', 'js', 'ts', 'sh', 'toml', 'ini', 'cfg', 'conf',
  'html', 'css', 'sql', 'rb', 'go', 'rs', 'java', 'c', 'cpp',
  'h', 'jsx', 'tsx', 'kt', 'swift', 'r', 'pl', 'lua', 'php',
  'bat', 'ps1',
]);

/** Supported format description for the rejection message. */
const SUPPORTED_FORMATS =
  'text/code files (.txt, .md, .py, .js, .ts, .json, .yaml, etc.) or PDF';

/**
 * Sanitize the bot token from an error message string.
 * Telegram file URLs embed the token:
 *   https://api.telegram.org/file/bot<TOKEN>/<path>
 * Same pattern as handlePhoto's catch block and runDetached in bot.ts.
 */
function sanitizeBotToken(raw: string): string {
  return raw.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
}

/**
 * Determine whether a document is text-like from its MIME type or extension.
 * Returns 'text', 'pdf', or 'unsupported'.
 */
function classifyDocument(
  mimeType: string | undefined,
  fileName: string | undefined,
): 'text' | 'pdf' | 'unsupported' {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';

  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';

  // Fallback: check file extension when MIME is absent or generic.
  const ext = (fileName ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';

  return 'unsupported';
}

type LimitedReadResult =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'too-large'; bytesRead: number }
  | { status: 'missing-body' };

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<LimitedReadResult> {
  const contentLength = response.headers.get('content-length');
  if (contentLength != null) {
    const expected = Number(contentLength);
    if (Number.isFinite(expected) && expected > maxBytes) {
      return { status: 'too-large', bytesRead: expected };
    }
  }

  const body = response.body;
  if (!body) return { status: 'missing-body' };

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { status: 'too-large', bytesRead: total };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return { status: 'ok', bytes: Buffer.concat(chunks, total) };
}

/**
 * Process an inbound Telegram document message and return the content blocks
 * to pass to the agent, or null if the document was rejected or failed.
 *
 * Contract:
 *   - Returns null when a reply explaining the rejection has already been sent
 *     (size cap, unsupported type) or when a precondition (message/document
 *     missing) fails.
 *   - Returns a ContentBlockParam[] when the document was successfully decoded;
 *     the caller enqueues or forwards these to processOne.
 *   - Caption, if present, is prepended as an additional text block.
 *   - Bot token is redacted from any error string before logging.
 */
export async function handleDocumentMessage(
  ctx: Context,
  log: (...args: unknown[]) => void,
): Promise<ContentBlockParam[] | null> {
  const msg = ctx.message as Message.DocumentMessage | undefined;
  const document = msg?.document;

  if (!msg || !document) {
    log('Document handling: missing message or document field');
    return null;
  }

  const chatId = ctx.chat?.id;
  const fileName = document.file_name;
  const mimeType = document.mime_type;

  // Size cap — bail before the CDN download when the metadata tells us it's too big.
  if (document.file_size != null && document.file_size > MAX_DOCUMENT_BYTES) {
    log(`Document handling: oversized file (${document.file_size} bytes) for chat ${chatId ?? '(unknown)'}`);
    await ctx.reply('❌ Document is too large (max 5 MB). Please send a smaller file.');
    return null;
  }

  const kind = classifyDocument(mimeType, fileName);

  if (kind === 'unsupported') {
    log(`Document handling: unsupported type mime=${mimeType ?? '(none)'} name=${fileName ?? '(none)'} for chat ${chatId ?? '(unknown)'}`);
    await ctx.reply(
      `❌ Unsupported document type. Please send ${SUPPORTED_FORMATS}.`,
    );
    return null;
  }

  // Download.
  let bytes: Buffer;
  try {
    const fileUrlRaw = await ctx.telegram.getFileLink(document.file_id);
    // Coerce to URL — some Telegraf forks return a plain string.
    const url = fileUrlRaw instanceof URL ? fileUrlRaw : new URL(String(fileUrlRaw));

    // Validate CDN URL (SSRF guard — mirrors photo handler M1/M4).
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.telegram.org' ||
      (url.port !== '' && url.port !== '443')
    ) {
      log(`Document handling: unexpected file URL (protocol=${url.protocol} hostname=${url.hostname}) for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply("❌ Couldn't download the document. Please try resending.");
      return null;
    }

    const response = await globalThis.fetch(url.href, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });

    if (!response.ok) {
      log(`Document handling: fetch failed status=${response.status} for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply("❌ Couldn't download the document. Please try resending.");
      return null;
    }

    const readResult = await readResponseBytesWithLimit(response, MAX_DOCUMENT_BYTES);
    if (readResult.status === 'too-large') {
      log(`Document handling: downloaded file (${readResult.bytesRead} bytes) exceeds limit for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply('❌ Document is too large (max 5 MB). Please send a smaller file.');
      return null;
    }
    if (readResult.status === 'missing-body') {
      log(`Document handling: fetch response had no body for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply("❌ Couldn't download the document. Please try resending.");
      return null;
    }
    bytes = readResult.bytes;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    log('Document handling download error:', sanitizeBotToken(raw));
    await ctx.reply("❌ Couldn't download the document. Please try resending.");
    return null;
  }

  // Build content blocks.
  const contentBlocks: ContentBlockParam[] = [];

  // Caption block first.
  if (msg.caption != null) {
    // Cap at 1024 Unicode code points (Telegram's own limit) to prevent
    // prompt-injection via an arbitrarily long caption.
    const capped = [...msg.caption].slice(0, 1024).join('');
    contentBlocks.push({ type: 'text', text: `[User caption]: ${capped}` });
  }

  if (kind === 'text') {
    const displayName = fileName ?? 'document';
    const text = bytes.toString('utf8');
    contentBlocks.push({
      type: 'document' as const,
      source: {
        type: 'text' as const,
        media_type: 'text/plain' as const,
        data: text,
      },
      title: `📎 Document: ${displayName}`,
    });
  } else {
    // PDF — base64-encode and send as a document block.
    const data = bytes.toString('base64');
    contentBlocks.push({
      type: 'document' as const,
      source: {
        type: 'base64' as const,
        media_type: 'application/pdf' as const,
        data,
      },
    });
  }

  return contentBlocks;
}
