/**
 * Tests for {@link h1ModelFetch}: verify that model API calls negotiate
 * HTTP/1.1, not HTTP/2, regardless of the global undici dispatcher state.
 *
 * Background: importing npm undici (directly or via jsdom) writes its Agent
 * with `allowH2: true` (default in undici 8) into the process-wide global-
 * dispatcher slot `globalThis[Symbol.for('undici.globalDispatcher.2')]` with
 * `configurable: false`. On Node 26, Node's built-in `fetch` uses the same
 * undici 8 global slot, so ALL `fetch()` calls — including those made by the
 * Anthropic and OpenAI SDK clients — can negotiate HTTP/2 and trigger the
 * spinning DATA-frame freeze observed on 2026-10-08. See issue #2528.
 *
 * These tests use a real TLS server (http2.createSecureServer with
 * allowHTTP1: true + a self-signed cert) to assert the negotiated ALPN
 * protocol, proving that h1ModelFetch always uses HTTP/1.1.
 *
 * @module agent/providers/shared/h1-fetch.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http2 from 'node:http2';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as readFileCb } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { h1ModelFetch } from './h1-fetch.js';

const execFile = promisify(execFileCb);
const readFile = promisify(readFileCb);

// ---------------------------------------------------------------------------
// Shared TLS server for all tests in this file
// ---------------------------------------------------------------------------

let server: http2.Http2SecureServer;
let serverPort: number;
let certDir: string;

/**
 * Generate a self-signed certificate in a temp dir using openssl (available on
 * every macOS/Linux host; used only in test). Returns the PEM key and cert.
 */
async function generateSelfSignedCert(dir: string): Promise<{ key: Buffer; cert: Buffer }> {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  await execFile('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ]);
  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  return { key, cert };
}

beforeAll(async () => {
  certDir = await mkdtemp(join(tmpdir(), 'afk-h1-fetch-test-'));
  const { key, cert } = await generateSelfSignedCert(certDir);

  // Invariant: createSecureServer with allowHTTP1:true accepts both h2 (ALPN
  // 'h2') and h1.1 (ALPN 'http/1.1') clients. The server reports the
  // negotiated httpVersion in its response so the test can assert it.
  server = http2.createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ httpVersion: req.httpVersion }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await rm(certDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('h1ModelFetch — always negotiates HTTP/1.1', () => {
  it('uses HTTP/1.1 (not HTTP/2) when fetching a TLS endpoint', async () => {
    const url = `https://127.0.0.1:${serverPort}/`;
    // h1ModelFetch uses undici's own Agent with allowH2: false and
    // rejectUnauthorized not set. We must pass rejectUnauthorized: false
    // only here in tests because the server has a self-signed cert.
    // The production h1Agent does NOT set rejectUnauthorized: false.
    // To keep the test realistic (use h1ModelFetch but skip TLS validation),
    // we temporarily override process.env.NODE_TLS_REJECT_UNAUTHORIZED.
    const prev = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const resp = await h1ModelFetch(url);
      const body = (await resp.json()) as { httpVersion: string };
      expect(body.httpVersion).toBe('1.1');
    } finally {
      if (prev === undefined) {
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      } else {
        process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prev;
      }
    }
  });

  it('still uses HTTP/1.1 after jsdom has poisoned the global undici dispatcher', async () => {
    // Contract: after jsdom writes an allowH2-enabled Agent into the global
    // dispatcher slot, h1ModelFetch must still negotiate HTTP/1.1.
    //
    // We simulate the poisoning by importing undici (which sets the global)
    // then asserting the test still passes. In the production case, jsdom is
    // always imported before any model API call.
    //
    // Invariant: this test must NOT import jsdom directly (it triggers other
    // side effects). Instead, it mimics the relevant part: importing undici,
    // which always installs its Agent (with allowH2 defaulting to enabled)
    // into the global dispatcher.
    const { Agent: UndiciAgent, setGlobalDispatcher } = await import('undici');
    const poisonAgent = new UndiciAgent({ allowH2: true });
    setGlobalDispatcher(poisonAgent);

    const url = `https://127.0.0.1:${serverPort}/`;
    const prev = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const resp = await h1ModelFetch(url);
      const body = (await resp.json()) as { httpVersion: string };
      // Must still be 1.1 — the explicit dispatcher on h1ModelFetch overrides
      // whatever is in the global slot.
      expect(body.httpVersion).toBe('1.1');
    } finally {
      if (prev === undefined) {
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      } else {
        process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prev;
      }
    }
  });
});
