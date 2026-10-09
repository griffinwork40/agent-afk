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
import { senderPrefix } from '../sender-attribution.js';
import { replyContextPrefix, type RepliedMessage } from '../reply-context.js';
import { forwardProvenancePrefix } from '../forward-provenance.js';
import { downloadTelegramFile } from '../media-download.js';

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
 *   - Bot token is redacted from any error string before logging (via
 *     downloadTelegramFile's token-safe diagnostics).
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
      `❌ Unsupported file type. Please send ${SUPPORTED_FORMATS}.`,
    );
    return null;
  }

  // Download via the shared bounded pipeline (SSRF guard, timeout, size cap).
  let fileUrlRaw: URL | string;
  try {
    fileUrlRaw = await ctx.telegram.getFileLink(document.file_id);
  } catch (err) {
    log('Document handling: getFileLink failed:', err instanceof Error ? err.message : String(err));
    await ctx.reply("❌ Couldn't download the document. Please try resending.");
    return null;
  }
  const dlResult = await downloadTelegramFile(fileUrlRaw, { maxBytes: MAX_DOCUMENT_BYTES });

  switch (dlResult.status) {
    case 'ssrf-rejected':
      log(`Document handling: unexpected file URL (protocol=${dlResult.protocol} hostname=${dlResult.hostname}) for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply("❌ Couldn't download the document. Please try resending.");
      return null;

    case 'fetch-failed':
      log(`Document handling: fetch failed status=${dlResult.httpStatus} for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply("❌ Couldn't download the document. Please try resending.");
      return null;

    case 'too-large':
      log(`Document handling: downloaded file (${dlResult.bytesRead} bytes) exceeds limit for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply('❌ Document is too large (max 5 MB). Please send a smaller file.');
      return null;

    case 'missing-body':
      log(`Document handling: fetch response had no body for chat ${chatId ?? '(unknown)'}`);
      await ctx.reply("❌ Couldn't download the document. Please try resending.");
      return null;

    case 'network-error':
      log('Document handling download error:', dlResult.safeMessage);
      await ctx.reply("❌ Couldn't download the document. Please try resending.");
      return null;

    case 'ok':
      break;
  }

  const bytes = dlResult.bytes;

  // Build content blocks.
  const contentBlocks: ContentBlockParam[] = [];

  // Attribution prefix — system-trusted sender marker + reply/forward context for
  // group/supergroup chats (mirrors handlePhoto and handle()).
  const prefix = senderPrefix(msg.from, ctx.chat?.type);
  const replyCtx = replyContextPrefix({
    replyToMessage: msg.reply_to_message as RepliedMessage | undefined,
    botId: ctx.botInfo?.id,
  });
  const fwdPrefix = forwardProvenancePrefix(msg);
  const attribution = replyCtx + fwdPrefix + prefix;

  // Caption block first.
  if (msg.caption != null) {
    // Cap at 1024 Unicode code points (Telegram's own limit) to prevent
    // prompt-injection via an arbitrarily long caption.
    const capped = [...msg.caption].slice(0, 1024).join('');
    contentBlocks.push({ type: 'text', text: `${attribution}[User caption]: ${capped}` });
  } else if (attribution) {
    // No caption but still attribute the sender and/or reply target.
    contentBlocks.push({ type: 'text', text: `${attribution}(document, no caption)` });
  }

  if (kind === 'text') {
    const displayName = fileName ?? 'document';
    const text = bytes.toString('utf8');
    contentBlocks.push({
      type: 'text' as const,
      text: `📎 Document: ${displayName}\n\n${text}`,
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
