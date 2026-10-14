/**
 * Bounded HTTP response-body reader shared by the Telegram media-download
 * pipeline and the photo-classification helpers.
 *
 * Extracted from `handlers/message.media-helpers.ts` to break the upward
 * dependency that `media-download.ts` (a utility module) had on the handler
 * layer (#3306/#3344 review finding).
 *
 * @module telegram/response-body-reader
 */

export type LimitedReadResult =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'too-large'; bytesRead: number }
  | { status: 'missing-body' };

/**
 * Stream a response body into a Buffer, aborting once `maxBytes` is exceeded.
 *
 * If the `Content-Length` response header already exceeds `maxBytes` the body
 * is never read — the check is a fast-path short circuit, not the only guard.
 */
export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<LimitedReadResult> {
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
