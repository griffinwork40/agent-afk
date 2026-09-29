/**
 * Regression test for nodejs/undici#5345 — the undici 7.27.0 gzip bridge bug.
 *
 * On Node 26.0.0 with undici 7.27.0 (npm), importing the npm package corrupts
 * the built-in fetch dispatcher: gzip-encoded responses lose their headers and
 * arrive as a still-compressed string instead of decompressed JSON. This was
 * fixed in undici 7.27.1 (UnwrapController gains rawHeaders/rawTrailers).
 *
 * This test:
 *   - Spins up a local node:http server that serves gzip JSON
 *   - Uses Node's built-in fetch (affected by the dispatcher override undici installs)
 *   - Asserts that content-type is present AND the body parses as valid JSON
 *
 * It passes on every Node version with a correct undici build. On Node 26 +
 * undici 7.27.0 it fails at the assertions, which is the discriminating signal
 * this CI leg was added to catch (see issue #2525 and .github/workflows/ci.yml).
 *
 * @see https://github.com/nodejs/undici/pull/5345
 */

import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';

/** Spin up a minimal HTTP server that returns gzip JSON, resolve when ready. */
function startGzipServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ok: true, value: 42 });
    const compressed = gzipSync(payload);

    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
      });
      res.end(compressed);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
      });
    });

    server.once('error', reject);
  });
}

describe('undici gzip-bridge compatibility (issue #2525)', () => {
  it(
    'built-in fetch returns headers and decompressed JSON body from a local gzip server',
    async () => {
      const { url, close } = await startGzipServer();
      try {
        // `fetch` here is Node's global built-in — the one whose dispatcher
        // undici overrides when imported as an npm package. On undici 7.27.0 +
        // Node 26, the response headers are empty and body is the raw gzip bytes.
        const res = await fetch(url);

        // 1) Content-Type header must be present (missing on 7.27.0 + Node 26).
        expect(res.headers.get('content-type')).toMatch(/application\/json/);

        // 2) Body must decompress and parse (still-gzipped on 7.27.0 + Node 26).
        const json = (await res.json()) as { ok: boolean; value: number };
        expect(json.ok).toBe(true);
        expect(json.value).toBe(42);
      } finally {
        close();
      }
    },
    // Generous timeout — server startup is instant locally; CI may be slower.
    10_000,
  );
});
