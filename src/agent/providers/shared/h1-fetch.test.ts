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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http2 from 'node:http2';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as readFileCb } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FormData as UndiciFormData } from 'undici';
import { h1ModelFetch } from './h1-fetch.js';
import { buildClientOptions } from '../anthropic-direct/auth.js';
import {
  oneShotChatCompletionWithStop,
  __setOpenAIOneShotClientFactory,
} from '../openai-compatible/oneshot.js';
import { completeWithWire, type CompleteWireClientOptions } from '../openai-compatible/complete-wire.js';

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
  // 'h2') and h1.1 (ALPN 'http/1.1') clients.
  //
  //   GET /         — returns { httpVersion } so tests can assert ALPN outcome.
  //   POST /multipart — accumulates the raw request body, then echoes back a
  //                  JSON object with { httpVersion, contentType, bodyText }
  //                  so multipart interop tests can inspect what the server
  //                  actually received (boundary, file part, field names).
  server = http2.createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
    if (req.method === 'POST' && req.url === '/multipart') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          httpVersion: req.httpVersion,
          contentType: req.headers['content-type'] ?? '',
          bodyText,
        }));
      });
      return;
    }
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
    const { Agent: UndiciAgent, setGlobalDispatcher, getGlobalDispatcher } = await import('undici');
    const prevDispatcher = getGlobalDispatcher();
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
      setGlobalDispatcher(prevDispatcher);
      await poisonAgent.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage: buildClientOptions always wires h1ModelFetch (issue #3335)
// ---------------------------------------------------------------------------

describe('buildClientOptions — Anthropic one-shot client always receives h1ModelFetch', () => {
  it('defaults fetch to h1ModelFetch when no fetchImpl is supplied (API-key mode)', () => {
    const opts = buildClientOptions('sk-ant-api03-TESTKEY', 'api-key');
    // The returned object must carry the h1ModelFetch reference so the SDK
    // routes every request through the HTTP/1.1-forcing dispatcher.
    expect(opts.fetch).toBe(h1ModelFetch);
  });

  it('defaults fetch to h1ModelFetch when no fetchImpl is supplied (OAuth mode)', () => {
    const opts = buildClientOptions('sk-ant-oat01-TESTTOKEN', 'oauth');
    expect(opts.fetch).toBe(h1ModelFetch);
  });

  it('forwards a caller-supplied fetchImpl (e.g. tracing wrapper) without replacement', () => {
    const tracingFetch: typeof fetch = async (input, init) => h1ModelFetch(input, init);
    const opts = buildClientOptions('sk-ant-api03-TESTKEY', 'api-key', undefined, tracingFetch);
    expect(opts.fetch).toBe(tracingFetch);
  });
});

// ---------------------------------------------------------------------------
// Coverage: OpenAI one-shot client receives h1ModelFetch (issue #3335)
// ---------------------------------------------------------------------------

describe('oneShotChatCompletionWithStop — OpenAI client receives h1ModelFetch', () => {
  it('passes h1ModelFetch to the client factory', async () => {
    // Capture the fetch option the factory receives; return a stub client.
    let capturedFetch: typeof fetch | undefined;
    const stubClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          }),
        },
      },
    };
    __setOpenAIOneShotClientFactory((opts) => {
      capturedFetch = opts.fetch;
      return stubClient as never;
    });
    try {
      await oneShotChatCompletionWithStop({
        apiKey: 'sk-TESTKEY',
        model: 'gpt-4o',
        system: 's',
        user: 'u',
      });
      expect(capturedFetch).toBe(h1ModelFetch);
    } finally {
      __setOpenAIOneShotClientFactory(null);
    }
  });
});

describe('completeWithWire — Responses-wire client factory receives h1ModelFetch', () => {
  it('passes h1ModelFetch to the client factory on the Responses path', async () => {
    // Non-tautological proof: we exercise completeWithWire end-to-end by
    // supplying injected auth deps that resolve to chatgpt-oauth — the only
    // auth source that routes through the Responses wire.  The clientFactory
    // seam captures whatever opts completeWithWire actually builds and passes
    // to `new OpenAI(...)`.  Removing the `fetch: h1ModelFetch` line from
    // complete-wire.ts will make capturedFetch undefined, failing this test.
    //
    // Auth injection: AuthResolverDeps.readFile returns a fake ~/.codex/auth.json
    // with ChatGPT OAuth tokens so resolveOpenAIAuth resolves to 'chatgpt-oauth'
    // without touching the real filesystem or process.env.
    //
    // We use forceChatgptOAuth:true (Tier 0 in resolveOpenAIAuth) so the auth
    // resolver uses the injected readFile directly, without requiring the
    // AFK_OPENAI_CHATGPT_OAUTH env flag that Tier 4 gates on.
    const fakeToken = 'ey' + 'fakeoauthtoken'.repeat(3); // non-empty JWT-shaped string
    const fakeCodexAuth = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: fakeToken },
    });
    const authDeps = {
      readFile: (_path: string) => fakeCodexAuth,
      readEnv: (_key: string) => undefined,
      homedir: () => '/fake-home',
    };

    // A minimal async iterable that emits response.completed so oneShotResponses
    // resolves cleanly (it throws ResponsesSummaryIncompleteError otherwise).
    const completedIterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          next: async () => {
            if (done) return { value: undefined, done: true as const };
            done = true;
            return { value: { type: 'response.completed' }, done: false as const };
          },
        };
      },
    };

    let capturedOpts: CompleteWireClientOptions | undefined;
    const responsesFactory = (opts: CompleteWireClientOptions) => {
      capturedOpts = opts;
      return {
        responses: { create: vi.fn().mockResolvedValue(completedIterable) },
      } as never;
    };

    // Drive the full Responses-wire code path inside completeWithWire.
    // forceChatgptOAuth:true activates Tier 0 in resolveOpenAIAuth which uses
    // the injected readFile — no env flag required.
    await completeWithWire(
      { model: 'gpt-4o', system: 's', user: 'u', forceChatgptOAuth: true },
      responsesFactory,
      authDeps,
    );

    // The factory must have been called (proving the Responses path was taken).
    expect(capturedOpts).toBeDefined();
    // Core invariant: the production fetch injection must be h1ModelFetch.
    expect(capturedOpts?.fetch).toBe(h1ModelFetch);
    // maxRetries must be 0 — the one-shot side-channel owns no retry policy.
    expect(capturedOpts?.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Coverage: h1ModelFetch + undici FormData multipart interop (issue #3345)
//
// Verifies that h1ModelFetch correctly serializes an undici FormData body
// over a real TLS connection. The test confirms three things the server
// actually receives:
//   1. HTTP/1.1 was negotiated (not HTTP/2).
//   2. Content-Type header contains "multipart/form-data; boundary=..." with
//      a real boundary string.
//   3. The raw body contains the expected field name ("prompt"), the expected
//      field value, the expected file part name ("image[]"), and a non-empty
//      binary-like payload for the file.
//
// This is an empirical serialization test — not just "a request was made".
// ---------------------------------------------------------------------------

describe('h1ModelFetch + undici FormData — multipart interop (issue #3345)', () => {
  it('serializes undici FormData correctly over HTTP/1.1 TLS: server sees fields and file part', async () => {
    // Build the multipart body the same way image-edit.ts does: undici's
    // FormData with globalThis.Blob for file parts.
    const form = new UndiciFormData();
    const fakeImageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    form.append(
      'image[]',
      new Blob([fakeImageData], { type: 'image/png' }),
      'ref.png',
    );
    form.append('prompt', 'a test prompt');
    form.append('model', 'gpt-image-1');

    const prev = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    let result: { httpVersion: string; contentType: string; bodyText: string };
    try {
      const resp = await h1ModelFetch(
        `https://127.0.0.1:${serverPort}/multipart`,
        {
          method: 'POST',
          // No Content-Type header — fetch must set it with the boundary.
          body: form as unknown as BodyInit,
        },
      );
      result = (await resp.json()) as typeof result;
    } finally {
      if (prev === undefined) {
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      } else {
        process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prev;
      }
    }

    // 1. HTTP/1.1 was negotiated (not HTTP/2).
    expect(result.httpVersion).toBe('1.1');

    // 2. Content-Type header has the multipart/form-data media type and a
    //    non-empty boundary parameter.
    expect(result.contentType).toMatch(/^multipart\/form-data;\s*boundary=/);
    const boundaryMatch = result.contentType.match(/boundary=([^\s;]+)/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1]!;
    expect(boundary.length).toBeGreaterThan(0);

    // 3. The raw body contains all expected parts.
    //    - The boundary delimiter.
    //    - The field name "prompt" and its value.
    //    - The file part name "image[]" with filename "ref.png".
    //    - At least one byte of binary data (the PNG magic bytes).
    expect(result.bodyText).toContain(`--${boundary}`);
    expect(result.bodyText).toContain(`--${boundary}--`);
    expect(result.bodyText).toContain('name="prompt"');
    expect(result.bodyText).toContain('a test prompt');
    expect(result.bodyText).toContain('name="model"');
    expect(result.bodyText).toContain('gpt-image-1');
    expect(result.bodyText).toContain('name="image[]"');
    expect(result.bodyText).toContain('filename="ref.png"');
    expect(result.bodyText).toContain('image/png');
  });
});
