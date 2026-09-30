/**
 * Regression test for issue #2525 / nodejs/undici#5345 (the undici 7.27.0
 * dispatch-handler-bridge bug).
 *
 * On Node 26.0.0 (bundled undici 8.0.2), once npm undici 7.27.0 is loaded,
 * Node's BUILT-IN fetch loses every response header and hands back the body
 * still gzip-compressed. It happens through two paths, and agent-afk uses both:
 *   1. Global slot: importing npm undici writes its Agent into
 *      globalThis[Symbol.for('undici.globalDispatcher.2')], and the built-in
 *      fetch then dispatches through it. This is the Anthropic/OpenAI SDK path.
 *   2. Per-request: egress-guard.ts passes an npm-undici `Agent` as
 *      `dispatcher` to globalThis.fetch. This is the web_scrape/web_request path.
 * Fixed in 7.27.1 (UnwrapController gains rawHeaders/rawTrailers).
 *
 * Invariant: both cases must route the built-in fetch through an npm-undici
 * Agent, or they pass on the broken version too. (The first draft never
 * imported undici and passed on 7.27.0 + Node 26.) Verified on Node 26.0.0:
 * both cases fail with 7.27.0 installed and pass with 7.30.0. The test only
 * discriminates on Node 26+, which is why CI has a `test-node26` job. On
 * Node 22/24 it is a plain passing check.
 *
 * No network: a local node:http server serves gzip JSON.
 * @see https://github.com/nodejs/undici/pull/5345
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PAYLOAD = { ok: true, value: 42 };
const GLOBAL_DISPATCHER_V2 = Symbol.for('undici.globalDispatcher.2');
const GLOBAL_DISPATCHER_V1 = Symbol.for('undici.globalDispatcher.1');

let server: Server;
let url: string;

beforeAll(async () => {
  const compressed = gzipSync(JSON.stringify(PAYLOAD));
  server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(compressed.length),
    });
    res.end(compressed);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function expectIntactResponse(res: Response): Promise<void> {
  // Missing on 7.27.0 + Node 26: every header is dropped.
  expect(res.headers.get('content-type')).toMatch(/application\/json/);
  // Still-gzipped on 7.27.0 + Node 26, so JSON parsing throws.
  expect(await res.json()).toEqual(PAYLOAD);
}

describe('undici gzip-bridge compatibility with built-in fetch (issue #2525)', () => {
  it('global-dispatcher path: npm-undici Agent in the process-wide slot', async () => {
    // In production npm undici loads before the first fetch, so its Agent ends
    // up in the slot. Inside a vitest worker the built-in fetch may already have
    // filled the slot with its own Agent, and npm undici only sets it when empty.
    // So install ours explicitly (what setGlobalDispatcher does), then restore
    // it. Both properties are writable, just not configurable.
    const slots = [GLOBAL_DISPATCHER_V2, GLOBAL_DISPATCHER_V1] as const;
    const g = globalThis as unknown as Record<symbol, unknown>;
    const saved = slots.map((s) => g[s]);
    const dispatcher = new Agent();
    setGlobalDispatcher(dispatcher);
    try {
      await expectIntactResponse(await fetch(url));
    } finally {
      slots.forEach((s, i) => {
        g[s] = saved[i];
      });
      await dispatcher.close();
    }
  });

  it('per-request path: npm-undici fetch + npm-undici Agent (egress-guard shape after #2528)', async () => {
    // After fix #2528 egress-guard uses npm undici's own `fetch` together with
    // its own `Agent` (guardedDispatcher), so both ends of the dispatch protocol
    // come from the same copy of undici — no cross-copy handshake on Node 26+.
    const dispatcher = new Agent();
    try {
      await expectIntactResponse(await undiciFetch(url, { dispatcher }));
    } finally {
      await dispatcher.close();
    }
  });
});
