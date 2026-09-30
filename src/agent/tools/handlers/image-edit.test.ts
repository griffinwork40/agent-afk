import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImageEditHandler } from './image-edit.js';

// Mock resolveOpenAIAuth so tests control auth resolution without touching disk.
vi.mock('../../providers/openai-compatible/auth.js', () => ({
  resolveOpenAIAuth: vi.fn(() => ({ apiKey: null, source: 'no-usable-auth' })),
}));

import { resolveOpenAIAuth } from '../../providers/openai-compatible/auth.js';
const mockResolveAuth = vi.mocked(resolveOpenAIAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(b64 = 'aGVsbG8='): Response {
  const body = JSON.stringify({
    created: Date.now(),
    data: [{ b64_json: b64 }],
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A tiny valid PNG (1×1 transparent pixel) as binary for reference images.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const TINY_PNG_BUF = Buffer.from(TINY_PNG_B64, 'base64');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('image_edit handler', () => {
  const signal = new AbortController().signal;
  let tmpDir: string | undefined;
  let refImagePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-image-edit-test-'));
    refImagePath = path.join(tmpDir, 'ref.png');
    await fs.writeFile(refImagePath, TINY_PNG_BUF);
    mockResolveAuth.mockReturnValue({ apiKey: null, source: 'no-usable-auth' });
  });

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  // ── Auth resolution ────────────────────────────────────────────────────

  it('returns error when no auth source is available', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    const handler = createImageEditHandler();
    const result = await handler({ prompt: 'edit this', image_paths: [refImagePath] }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('AFK_IMAGE_API_KEY');
    expect(result.content).toContain('OPENAI_API_KEY');
  });

  it('falls back to resolveOpenAIAuth when AFK_IMAGE_API_KEY is unset', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({ apiKey: 'sk-resolved', source: 'env', envVar: 'OPENAI_API_KEY' });
    const handler = createImageEditHandler();
    // Proceeds past auth to input validation — no auth error.
    const result = await handler({}, signal, { cwd: tmpDir, sessionId: 'fallback-auth-test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('prompt');
    expect(result.content).not.toContain('auth');
  });

  it('prefers AFK_IMAGE_API_KEY over resolveOpenAIAuth', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'dedicated-key');
    mockResolveAuth.mockReturnValue({ apiKey: 'other-key', source: 'env' });
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    mockResolveAuth.mockClear();
    await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'pref-key-test' },
    );
    const [, opts] = fetchFn.mock.calls[0]!;
    expect(opts.headers['Authorization']).toBe('Bearer dedicated-key');
    expect(mockResolveAuth).not.toHaveBeenCalled();
  });

  it('returns expired-token error for chatgpt-oauth-expired', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({ apiKey: null, source: 'chatgpt-oauth-expired', expiresAt: 1 });
    const handler = createImageEditHandler();
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('expired');
  });

  // ── Daemon gate ─────────────────────────────────────────────────────────

  it('blocks in daemon mode when AFK_IMAGE_ALLOW_DAEMON is not set', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    vi.stubEnv('AFK_DAEMON_TASK_ID', 'some-task');
    const handler = createImageEditHandler();
    const result = await handler({ prompt: 'test', image_paths: [refImagePath] }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('daemon');
  });

  it('allows daemon mode when AFK_IMAGE_ALLOW_DAEMON=1', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    vi.stubEnv('AFK_DAEMON_TASK_ID', 'some-task');
    vi.stubEnv('AFK_IMAGE_ALLOW_DAEMON', '1');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'daemon-allow-test' },
    );
    expect(result.isError).toBeUndefined();
  });

  // ── Input validation ────────────────────────────────────────────────────

  it('rejects missing prompt', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageEditHandler();
    const result = await handler(
      { image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'val-prompt-test' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('prompt');
  });

  it('rejects missing image_paths', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageEditHandler();
    const result = await handler(
      { prompt: 'test' },
      signal,
      { cwd: tmpDir, sessionId: 'val-paths-test' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('image_paths');
  });

  it('rejects empty image_paths array', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageEditHandler();
    const result = await handler(
      { prompt: 'test', image_paths: [] },
      signal,
      { cwd: tmpDir, sessionId: 'val-empty-paths-test' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('image_paths');
  });

  it('rejects more than 16 image paths', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageEditHandler();
    const paths = Array.from({ length: 17 }, () => refImagePath);
    const result = await handler(
      { prompt: 'test', image_paths: paths },
      signal,
      { cwd: tmpDir, sessionId: 'val-too-many-paths' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('16');
  });

  it('rejects invalid model', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageEditHandler();
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath], model: 'dall-e-3' },
      signal,
      { cwd: tmpDir, sessionId: 'val-model-test' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid model');
  });

  it('rejects unsupported reference image extension', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const gifPath = path.join(tmpDir!, 'ref.gif');
    await fs.writeFile(gifPath, Buffer.from('GIF89a'));
    const handler = createImageEditHandler();
    const result = await handler(
      { prompt: 'test', image_paths: [gifPath] },
      signal,
      { cwd: tmpDir, sessionId: 'val-ext-test' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unsupported extension');
  });

  it('returns error when reference image does not exist', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageEditHandler();
    const result = await handler(
      { prompt: 'test', image_paths: [path.join(tmpDir!, 'nonexistent.png')] },
      signal,
      { cwd: tmpDir, sessionId: 'val-missing-file-test' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Cannot stat');
  });

  it('returns error when reference image exceeds 25 MiB limit', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    // Create a real large file that exceeds the 25 MiB per-image limit.
    const largePath = path.join(tmpDir!, 'large.png');
    const OVER_25_MIB = 25 * 1024 * 1024 + 1;
    await fs.writeFile(largePath, Buffer.alloc(OVER_25_MIB));
    const handler = createImageEditHandler();
    const result = await handler(
      { prompt: 'test', image_paths: [largePath] },
      signal,
      { cwd: tmpDir, sessionId: 'val-size-test' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('25 MiB');
  });

  // ── Session limit ───────────────────────────────────────────────────────

  it('enforces per-session edit limit', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    vi.stubEnv('AFK_IMAGE_SESSION_LIMIT', '2');
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(makeOkResponse(TINY_PNG_B64))
      .mockResolvedValueOnce(makeOkResponse(TINY_PNG_B64))
      .mockResolvedValueOnce(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const sid = `limit-test-${Date.now()}`;
    const ctx = { cwd: tmpDir, sessionId: sid };
    const args = { prompt: 'test', image_paths: [refImagePath] };

    const r1 = await handler(args, signal, ctx);
    expect(r1.isError).toBeUndefined();
    const r2 = await handler(args, signal, ctx);
    expect(r2.isError).toBeUndefined();

    // Third should be blocked.
    const r3 = await handler(args, signal, ctx);
    expect(r3.isError).toBe(true);
    expect(r3.content).toContain('limit reached');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // ── Successful edit ─────────────────────────────────────────────────────

  it('calls the Images Edit API and saves the edited image to disk', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'make it blue', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'gen-test-session' },
    );

    expect(result.isError).toBeUndefined();

    const meta = JSON.parse(result.content);
    expect(meta.model).toBe('gpt-image-1');
    expect(meta.path).toMatch(/edited-.*\.png$/);
    expect(meta.bytes).toBeGreaterThan(0);
    expect(meta.source_images).toEqual([refImagePath]);

    // Verify the file was written.
    const stat = await fs.stat(meta.path);
    expect(stat.size).toBe(meta.bytes);

    // Verify multipart API call.
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, opts] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(opts.headers['Authorization']).toBe('Bearer test-key');
    // Content-Type should NOT be set manually (fetch sets it with the boundary).
    expect(opts.headers['Content-Type']).toBeUndefined();
    // Body should be FormData.
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('accepts .jpg reference images', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const jpgPath = path.join(tmpDir!, 'ref.jpg');
    await fs.writeFile(jpgPath, TINY_PNG_BUF);
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [jpgPath] },
      signal,
      { cwd: tmpDir, sessionId: `ext-test-jpg-${Date.now()}` },
    );
    expect(result.isError).toBeUndefined();
  });

  it('accepts .webp reference images', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const webpPath = path.join(tmpDir!, 'ref.webp');
    await fs.writeFile(webpPath, TINY_PNG_BUF);
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [webpPath] },
      signal,
      { cwd: tmpDir, sessionId: `ext-test-webp-${Date.now()}-b` },
    );
    expect(result.isError).toBeUndefined();
  });

  it('saves to custom output_path when specified', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const customPath = path.join(tmpDir!, 'custom', 'output.png');
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath], output_path: customPath },
      signal,
      { cwd: tmpDir, sessionId: 'custom-path-session' },
    );

    expect(result.isError).toBeUndefined();
    const meta = JSON.parse(result.content);
    expect(meta.path).toBe(customPath);
    const stat = await fs.stat(customPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('sends multiple image paths as multiple form fields', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const ref2Path = path.join(tmpDir!, 'ref2.png');
    await fs.writeFile(ref2Path, TINY_PNG_BUF);
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    await handler(
      { prompt: 'blend', image_paths: [refImagePath, ref2Path] },
      signal,
      { cwd: tmpDir, sessionId: 'multi-img-session' },
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    const [, opts] = fetchFn.mock.calls[0]!;
    const form: FormData = opts.body;
    // getAll returns all values for the key
    expect(form.getAll('image[]').length).toBe(2);
  });

  // ── API error handling ──────────────────────────────────────────────────

  it('returns error on API failure', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeErrorResponse(429, 'Rate limit exceeded'));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'err-session' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('429');
  });

  it('returns error on network failure', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'net-err-session' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ECONNREFUSED');
  });

  it('returns error when API response has no image data', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{}] }), { status: 200 }),
    );
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'no-data-session' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no image data');
  });

  // ── Metadata ────────────────────────────────────────────────────────────

  it('uses default model, size, and format when not specified', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: 'defaults-session' },
    );
    expect(result.isError).toBeUndefined();
    const meta = JSON.parse(result.content);
    expect(meta.model).toBe('gpt-image-1');
    expect(meta.size).toBe('1024x1024');
    expect(meta.format).toBe('png');
    expect(meta.auth_source).toBe('AFK_IMAGE_API_KEY');
  });

  it('includes session edit counter in metadata', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const sid = `counter-test-${Date.now()}`;
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { cwd: tmpDir, sessionId: sid },
    );
    const meta = JSON.parse(result.content);
    expect(meta.session_edits_used).toBe(1);
    expect(meta.session_edits_limit).toBe(10);
  });
});
