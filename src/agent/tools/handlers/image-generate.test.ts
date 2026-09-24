import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { createImageGenerateHandler } from './image-generate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(b64 = 'aGVsbG8=', revisedPrompt?: string): Response {
  const body = JSON.stringify({
    created: Date.now(),
    data: [{ b64_json: b64, revised_prompt: revisedPrompt }],
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A tiny valid PNG (1x1 transparent pixel) as base64 for realistic tests.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('image_generate handler', () => {
  const signal = new AbortController().signal;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp('/tmp/afk-image-gen-test-');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── API key gating ──────────────────────────────────────────────────────

  it('returns error when AFK_IMAGE_API_KEY is not set', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'a cat' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('AFK_IMAGE_API_KEY');
    vi.unstubAllEnvs();
  });

  // ── Input validation ────────────────────────────────────────────────────

  it('rejects missing prompt', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageGenerateHandler();
    const result = await handler({}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('prompt');
    vi.unstubAllEnvs();
  });

  it('rejects invalid model', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'test', model: 'dall-e-3' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid model');
    vi.unstubAllEnvs();
  });

  it('rejects invalid size', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'test', size: '512x512' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid size');
    vi.unstubAllEnvs();
  });

  // ── Daemon gate ─────────────────────────────────────────────────────────

  it('blocks in daemon mode when AFK_IMAGE_ALLOW_DAEMON is not set', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    vi.stubEnv('AFK_DAEMON_TASK_ID', 'some-task');
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'test' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('daemon');
    vi.unstubAllEnvs();
  });

  it('allows daemon mode when AFK_IMAGE_ALLOW_DAEMON=1', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    vi.stubEnv('AFK_DAEMON_TASK_ID', 'some-task');
    vi.stubEnv('AFK_IMAGE_ALLOW_DAEMON', '1');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler({ prompt: 'test' }, signal, { cwd: tmpDir });
    expect(result.isError).toBeUndefined();
    vi.unstubAllEnvs();
  });

  // ── Session limit ───────────────────────────────────────────────────────

  it('enforces per-session generation limit', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    vi.stubEnv('AFK_IMAGE_SESSION_LIMIT', '2');
    // Each call needs its own Response (body is consumed once).
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(makeOkResponse(TINY_PNG_B64))
      .mockResolvedValueOnce(makeOkResponse(TINY_PNG_B64))
      .mockResolvedValueOnce(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const sid = `limit-test-${Date.now()}`;
    const ctx = { cwd: tmpDir, sessionId: sid };

    // First two should succeed
    const r1 = await handler({ prompt: 'test1' }, signal, ctx);
    expect(r1.isError).toBeUndefined();
    const r2 = await handler({ prompt: 'test2' }, signal, ctx);
    expect(r2.isError).toBeUndefined();

    // Third should be blocked (before fetch is called)
    const r3 = await handler({ prompt: 'test3' }, signal, ctx);
    expect(r3.isError).toBe(true);
    expect(r3.content).toContain('limit reached');
    expect(fetchFn).toHaveBeenCalledTimes(2); // only 2 API calls made
    vi.unstubAllEnvs();
  });

  // ── Successful generation ───────────────────────────────────────────────

  it('calls OpenAI API and saves image to disk', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(
      makeOkResponse(TINY_PNG_B64, 'a happy cat sitting on a cloud'),
    );
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'a cat', model: 'gpt-image-1', size: '1024x1024' },
      signal,
      { cwd: tmpDir, sessionId: 'gen-test-session' },
    );

    expect(result.isError).toBeUndefined();
    // Should NOT have image field (context bomb protection)
    expect(result.image).toBeUndefined();

    const meta = JSON.parse(result.content);
    expect(meta.model).toBe('gpt-image-1');
    expect(meta.size).toBe('1024x1024');
    expect(meta.revised_prompt).toBe('a happy cat sitting on a cloud');
    expect(meta.path).toMatch(/\.png$/);
    expect(meta.bytes).toBeGreaterThan(0);

    // Verify file was written
    const stat = await fs.stat(meta.path);
    expect(stat.size).toBe(meta.bytes);

    // Verify API was called correctly
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, opts] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(opts.headers['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(opts.body);
    expect(body.prompt).toBe('a cat');
    expect(body.model).toBe('gpt-image-1');
    vi.unstubAllEnvs();
  });

  it('saves to custom output_path when specified', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const customPath = `${tmpDir}/custom/output.png`;
    const result = await handler(
      { prompt: 'test', output_path: customPath },
      signal,
      { cwd: tmpDir, sessionId: 'custom-path-session' },
    );

    expect(result.isError).toBeUndefined();
    const meta = JSON.parse(result.content);
    expect(meta.path).toBe(customPath);
    const stat = await fs.stat(customPath);
    expect(stat.size).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });

  // ── API error handling ──────────────────────────────────────────────────

  it('returns error on API failure', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(
      makeErrorResponse(429, 'Rate limit exceeded'),
    );
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler({ prompt: 'test' }, signal, { cwd: tmpDir, sessionId: 'err-session' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('429');
    vi.unstubAllEnvs();
  });

  it('returns error on network failure', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler({ prompt: 'test' }, signal, { cwd: tmpDir, sessionId: 'net-err-session' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ECONNREFUSED');
    vi.unstubAllEnvs();
  });

  it('returns error when API response has no image data', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{}] }), { status: 200 }),
    );
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler({ prompt: 'test' }, signal, { cwd: tmpDir, sessionId: 'no-data-session' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no image data');
    vi.unstubAllEnvs();
  });

  // ── Default values ──────────────────────────────────────────────────────

  it('uses default model, size, quality, and format when not specified', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    await handler({ prompt: 'test' }, signal, { cwd: tmpDir, sessionId: 'defaults-session' });

    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.model).toBe('gpt-image-1');
    expect(body.size).toBe('1024x1024');
    expect(body.quality).toBe('auto');
    expect(body.output_format).toBe('png');
    vi.unstubAllEnvs();
  });
});
