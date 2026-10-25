import type { IncomingMessage } from 'node:http';

/** Cap request bodies at 1 MiB — matches the web-server guard. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Read the full HTTP request body as a UTF-8 string.
 * Rejects with an error if the body exceeds {@link MAX_BODY_BYTES}.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
