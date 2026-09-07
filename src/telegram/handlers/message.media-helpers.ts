/**
 * Image MIME-type sniffing and response-body size-limiting helpers.
 *
 * Extracted from message.ts to stay under the 350-code-line ceiling.
 * These are pure utility functions with no coupling to Telegram or sessions.
 *
 * @module telegram/handlers/message.media-helpers
 */

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
