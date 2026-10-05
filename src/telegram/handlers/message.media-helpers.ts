/**
 * Image MIME-type sniffing, response-body size-limiting, and photo-fetch helpers.
 *
 * Extracted from message.ts to stay under the 350-code-line ceiling.
 * Pure utility functions with no coupling to Telegram sessions.
 *
 * @module telegram/handlers/message.media-helpers
 */

import type { Context } from 'telegraf';

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
 */
export async function fetchAndClassifyPhoto(
  ctx: Context,
  fileId: string,
  chatId: number,
  log: LogFn,
): Promise<FetchPhotoResult> {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB

  // M1: validate the CDN URL before fetching to guard against SSRF.
  // Check protocol, hostname, and port -- hostname-only checks can be bypassed
  // via non-standard ports or non-HTTPS schemes. Pass redirect:'error' so a
  // redirect to an internal address is never silently followed.
  const fileUrlRaw = await ctx.telegram.getFileLink(fileId);
  // M4: coerce to URL -- some Telegraf forks return a string instead of URL.
  const url = fileUrlRaw instanceof URL ? fileUrlRaw : new URL(String(fileUrlRaw));
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.telegram.org' ||
    (url.port !== '' && url.port !== '443')
  ) {
    // Do NOT log url.href -- it contains the live bot token in the path segment.
    log(`Photo handling: unexpected file URL (protocol=${url.protocol} hostname=${url.hostname}) rejected for chat ${chatId}`);
    await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
    return { ok: false };
  }
  // M3: 15-second timeout prevents a stalled CDN response from blocking the handler
  const response = await globalThis.fetch(url.href, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) {
    log(`Photo handling: fetch failed with status ${response.status} for chat ${chatId}`);
    await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
    return { ok: false };
  }
  const readResult = await readResponseBytesWithLimit(response, MAX_PHOTO_BYTES);
  if (readResult.status === 'too-large') {
    log(`Photo handling: downloaded file (${readResult.bytesRead} bytes) exceeds limit for chat ${chatId}`);
    await ctx.reply('❌ Image is too large (max 5 MB). Please send a smaller photo.');
    return { ok: false };
  }
  if (readResult.status === 'missing-body') {
    log(`Photo handling: fetch response had no body for chat ${chatId}`);
    await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
    return { ok: false };
  }
  const bytes = readResult.bytes;

  // H1: derive MIME type from the response Content-Type header instead of
  // hardcoding image/jpeg -- Telegram can serve PNG, GIF, and WebP as well.
  const rawContentType = response.headers.get('content-type') ?? '';
  // Lowercase before allow-list comparison -- HTTP headers are case-insensitive
  // per RFC 7231, so 'Image/JPEG' must match as readily as 'image/jpeg'.
  const detectedMime = (rawContentType.split(';')[0]?.trim() ?? '').toLowerCase();
  let media_type: AllowedPhotoMime;
  if ((ALLOWED_PHOTO_MIME as readonly string[]).includes(detectedMime)) {
    media_type = detectedMime as AllowedPhotoMime;
  } else {
    // Content-Type absent or unrecognised: sniff magic bytes so we never
    // mislabel PNG/GIF/WebP bytes as image/jpeg and get rejected by Anthropic.
    const sniffed = sniffMimeType(bytes);
    if (sniffed !== null) {
      log(`Photo: sniffed ${sniffed} (Content-Type was "${rawContentType}") for chat ${chatId}`);
      media_type = sniffed;
    } else {
      // Completely unrecognised format -- reject explicitly rather than sending
      // mislabelled bytes that the Anthropic API will reject server-side.
      log(`Photo: unrecognised image format for chat ${chatId} (Content-Type: "${rawContentType}")`);
      await ctx.reply('❌ Unsupported image format. Please send a JPEG, PNG, GIF, or WebP.');
      return { ok: false };
    }
  }

  return { ok: true, bytes, media_type };
}
