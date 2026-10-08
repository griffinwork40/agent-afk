/**
 * Image MIME-type sniffing, response-body size-limiting, and photo-fetch helpers.
 *
 * Extracted from message.ts to stay under the 350-code-line ceiling.
 * Mostly pure utilities; fetchAndClassifyPhoto accepts a Telegraf Context to
 * call getFileLink, so there is a light Telegram coupling in that function.
 *
 * @module telegram/handlers/message.media-helpers
 */

import type { Context } from 'telegraf';
import { downloadTelegramFile } from '../media-download.js';

/**
 * Inspect magic bytes at the start of a buffer and return the corresponding
 * image MIME type, or null if the signature is not recognised.
 *
 * Checked signatures:
 *   PNG  -- 89 50 4E 47 (4 bytes)
 *   GIF  -- 47 49 46    (3 bytes, "GIF" prefix covers GIF87a and GIF89a)
 *   WebP -- 52 49 46 46 ... 57 45 42 50 (RIFF container; "WEBP" at bytes 8-11)
 *   JPEG -- FF D8 FF    (SOI + start-of-marker)
 */
export function sniffMimeType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (bytes.length < 3) return null;

  // PNG: 89 50 4E 47
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47
  ) return 'image/png';

  // GIF: 47 49 46 ("GIF")
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return 'image/gif';

  // WebP: RIFF container with "WEBP" at bytes 8-11
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 &&  // 'R', 'I'
    bytes[2] === 0x46 && bytes[3] === 0x46 &&  // 'F', 'F'
    bytes[8]  === 0x57 && bytes[9]  === 0x45 && // 'W', 'E'
    bytes[10] === 0x42 && bytes[11] === 0x50    // 'B', 'P'
  ) return 'image/webp';

  // JPEG: FF D8 FF (SOI marker)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';

  return null;
}

export type LimitedReadResult =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'too-large'; bytesRead: number }
  | { status: 'missing-body' };

export async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<LimitedReadResult> {
  const contentLength = response.headers.get('content-length');
  if (contentLength != null) {
    const expectedBytes = Number(contentLength);
    if (Number.isFinite(expectedBytes) && expectedBytes > maxBytes) {
      return { status: 'too-large', bytesRead: expectedBytes };
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

/** Allowed image MIME types for Anthropic's vision API. */
export const ALLOWED_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type AllowedPhotoMime = typeof ALLOWED_PHOTO_MIME[number];

export type FetchPhotoResult =
  | { ok: true; bytes: Buffer; media_type: AllowedPhotoMime }
  | { ok: false }; // error already sent via ctx.reply

type LogFn = (...args: unknown[]) => void;

/**
 * Validate the CDN URL, download the photo bytes, and detect the MIME type.
 *
 * Returns `{ ok: true, bytes, media_type }` on success, or `{ ok: false }` when
 * an error was sent to the user via `ctx.reply` and the caller should return.
 *
 * Contract: MAX_PHOTO_BYTES is 5 MiB; the function enforces that limit.
 * Callers must not call getFileLink before this -- that call happens here.
 *
 * All security restrictions (SSRF guard, redirect rejection, timeout, size cap)
 * are enforced by downloadTelegramFile from src/telegram/media-download.ts.
 */
export async function fetchAndClassifyPhoto(
  ctx: Context,
  fileId: string,
  chatId: number,
  log: LogFn,
): Promise<FetchPhotoResult> {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB

  const fileUrlRaw = await ctx.telegram.getFileLink(fileId);
  const dlResult = await downloadTelegramFile(fileUrlRaw, { maxBytes: MAX_PHOTO_BYTES });

  switch (dlResult.status) {
    case 'ssrf-rejected':
      // Do NOT log url.href -- it contains the live bot token in the path segment.
      log(`Photo handling: unexpected file URL (protocol=${dlResult.protocol} hostname=${dlResult.hostname}) rejected for chat ${chatId}`);
      await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
      return { ok: false };

    case 'fetch-failed':
      log(`Photo handling: fetch failed with status ${dlResult.httpStatus} for chat ${chatId}`);
      await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
      return { ok: false };

    case 'too-large':
      log(`Photo handling: downloaded file (${dlResult.bytesRead} bytes) exceeds limit for chat ${chatId}`);
      await ctx.reply('❌ Image is too large (max 5 MB). Please send a smaller photo.');
      return { ok: false };

    case 'missing-body':
      log(`Photo handling: fetch response had no body for chat ${chatId}`);
      await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
      return { ok: false };

    case 'network-error':
      log(`Photo handling: network error for chat ${chatId}:`, dlResult.safeMessage);
      await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
      return { ok: false };

    case 'ok':
      break;
  }

  const bytes = dlResult.bytes;

  // H1: derive MIME type from the response Content-Type header instead of
  // hardcoding image/jpeg -- Telegram can serve PNG, GIF, and WebP as well.
  // Note: we no longer have direct access to the response object here, so we
  // derive the MIME type from magic bytes (sniffMimeType), which is the more
  // reliable path anyway (Content-Type sniffing was the fallback in the old
  // code when Content-Type was absent or unrecognised).
  const sniffed = sniffMimeType(bytes);
  if (sniffed !== null) {
    return { ok: true, bytes, media_type: sniffed };
  }

  // Completely unrecognised format -- reject explicitly rather than sending
  // mislabelled bytes that the Anthropic API will reject server-side.
  log(`Photo: unrecognised image format for chat ${chatId}`);
  await ctx.reply('❌ Unsupported image format. Please send a JPEG, PNG, GIF, or WebP.');
  return { ok: false };
}
