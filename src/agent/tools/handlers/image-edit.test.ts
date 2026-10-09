import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImageEditHandler } from './image-edit.js';
import { _resetWriteDenylistCacheForTests } from './write-denylist.js';
import { _resetRootRealpathCacheForTests } from './_cwd-utils.js';

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
    const result = await handler({}, signal, { resolveBase: tmpDir, sessionId: 'fallback-auth-test' });
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
      { resolveBase: tmpDir, sessionId: 'pref-key-test' },
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

  it('rejects chatgpt-oauth source without calling the Images Edit API', async () => {
    // The Images Edit endpoint does not accept ChatGPT OAuth tokens (wrong
    // OAuth scopes). The handler must reject with a clear error naming the
    // supported credential sources and never reach the fetch call.
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({
      apiKey: 'chatgpt-oauth-token',
      source: 'chatgpt-oauth',
      accountId: 'acct-123',
    });
    const fetchFn = vi.fn();
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { resolveBase: tmpDir, sessionId: 'oauth-reject-test' },
    );
    expect(result.isError).toBe(true);
    // Must name the supported credentials.
    expect(result.content).toContain('AFK_IMAGE_API_KEY');
    expect(result.content).toContain('OPENAI_API_KEY');
    // Must NOT have forwarded the OAuth token to the Images Edit endpoint.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns no-usable-auth error when a ChatGPT login has no access token', async () => {
    // A ChatGPT-mode ~/.codex/auth.json with no access token makes
    // resolveOpenAIAuth return source:'no-usable-auth-codex-oauth'. The
    // handler must surface an actionable error — not call the endpoint.
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({
      apiKey: null,
      source: 'no-usable-auth-codex-oauth',
    });
    const fetchFn = vi.fn();
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath] },
      signal,
      { resolveBase: tmpDir, sessionId: 'flag-off-test' },
    );
    expect(result.isError).toBe(true);
    // The no-usable-auth path must name at least one actionable credential source.
    expect(result.content).toContain('AFK_IMAGE_API_KEY');
    // Must never have called the Images Edit endpoint.
    expect(fetchFn).not.toHaveBeenCalled();
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
      { resolveBase: tmpDir, sessionId: 'daemon-allow-test' },
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
      { resolveBase: tmpDir, sessionId: 'val-prompt-test' },
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
      { resolveBase: tmpDir, sessionId: 'val-paths-test' },
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
      { resolveBase: tmpDir, sessionId: 'val-empty-paths-test' },
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
      { resolveBase: tmpDir, sessionId: 'val-too-many-paths' },
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
      { resolveBase: tmpDir, sessionId: 'val-model-test' },
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
      { resolveBase: tmpDir, sessionId: 'val-ext-test' },
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
      { resolveBase: tmpDir, sessionId: 'val-missing-file-test' },
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
      { resolveBase: tmpDir, sessionId: 'val-size-test' },
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
    const ctx = { resolveBase: tmpDir, sessionId: sid };
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
      { resolveBase: tmpDir, sessionId: 'gen-test-session' },
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
      { resolveBase: tmpDir, sessionId: `ext-test-jpg-${Date.now()}` },
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
      { resolveBase: tmpDir, sessionId: `ext-test-webp-${Date.now()}-b` },
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
      { resolveBase: tmpDir, sessionId: 'custom-path-session' },
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
      { resolveBase: tmpDir, sessionId: 'multi-img-session' },
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
      { resolveBase: tmpDir, sessionId: 'err-session' },
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
      { resolveBase: tmpDir, sessionId: 'net-err-session' },
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
      { resolveBase: tmpDir, sessionId: 'no-data-session' },
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
      { resolveBase: tmpDir, sessionId: 'defaults-session' },
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
      { resolveBase: tmpDir, sessionId: sid },
    );
    const meta = JSON.parse(result.content);
    expect(meta.session_edits_used).toBe(1);
    expect(meta.session_edits_limit).toBe(10);
  });

  // ── Dangling symlink security (#2823) ────────────────────────────────────

  it('refuses a dangling symlink output_path whose target is outside the write root', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    _resetRootRealpathCacheForTests();
    _resetWriteDenylistCacheForTests();

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-edit-outside-'));
    const outsideFile = path.join(outsideDir, 'escaped.png');
    const linkPath = path.join(tmpDir!, 'evil.png');
    fsSync.symlinkSync(outsideFile, linkPath); // dangling: target parent exists, file doesn't

    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath], output_path: linkPath },
      signal,
      { cwd: tmpDir, sessionId: 'edit-symlink-escape', resolveBase: tmpDir, writeRoots: [tmpDir!] },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside.*write roots|write roots/i);
    await expect(fs.access(outsideFile)).rejects.toThrow();

    await fs.rm(outsideDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    _resetRootRealpathCacheForTests();
  });

  it('refuses a dangling symlink output_path pointing at a denylisted path', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    _resetRootRealpathCacheForTests();
    _resetWriteDenylistCacheForTests();

    const homeDir = os.homedir();
    const denyTarget = path.join(homeDir, '.ssh', 'injected.png');
    const linkPath = path.join(tmpDir!, 'denylink.png');
    fsSync.symlinkSync(denyTarget, linkPath);

    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageEditHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', image_paths: [refImagePath], output_path: linkPath },
      signal,
      { cwd: tmpDir, sessionId: 'edit-symlink-deny', resolveBase: tmpDir, writeRoots: [tmpDir!, homeDir] },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/protected path|denylist/i);
    vi.unstubAllEnvs();
    _resetRootRealpathCacheForTests();
    _resetWriteDenylistCacheForTests();
  });

  // ── Intermediate symlinked-directory escape (#2836 Item 1) ───────────────

  it('refuses output_path via intermediate symlinked dir whose relative target escapes root', async () => {
    // Scenario:
    //   root/subdir/         (real directory)
    //   root/dirLink -> root/subdir/  (directory symlink)
    //   root/subdir/hop.png -> ../../outside/escaped.png  (relative escape)
    //   Access via: root/dirLink/hop.png
    //
    // The physical-parent fix resolves the relative symlink against the real
    // parent (root/subdir), so ../../ correctly escapes root.
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    _resetRootRealpathCacheForTests();
    _resetWriteDenylistCacheForTests();

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-edit-outside-'));
    try {
      // Create outside destination.
      await fs.mkdir(path.join(outsideDir, 'outside'), { recursive: true });
      const escapedFile = path.join(outsideDir, 'outside', 'escaped.png');
      await fs.writeFile(escapedFile, 'sensitive');

      // Create subdir inside root.
      const subdir = path.join(tmpDir!, 'subdir');
      await fs.mkdir(subdir);

      // Create directory symlink: root/dirLink -> root/subdir.
      const dirLink = path.join(tmpDir!, 'dirLink');
      fsSync.symlinkSync(subdir, dirLink);

      // Create relative escape symlink inside subdir.
      const relEscape = path.join(
        path.relative(subdir, path.dirname(outsideDir)),
        'outside',
        'escaped.png',
      );
      fsSync.symlinkSync(relEscape, path.join(subdir, 'hop.png'));

      // Access via the directory symlink path.
      const accessPath = path.join(dirLink, 'hop.png');

      const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
      const handler = createImageEditHandler(fetchFn);
      const result = await handler(
        { prompt: 'test', image_paths: [refImagePath], output_path: accessPath },
        signal,
        { cwd: tmpDir, sessionId: 'edit-dirlink-escape', resolveBase: tmpDir, writeRoots: [tmpDir!] },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside.*write roots|write roots/i);
      // Verify the outside file was not modified.
      const stat = await fs.stat(escapedFile);
      expect(stat.size).toBe('sensitive'.length);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
      _resetRootRealpathCacheForTests();
      _resetWriteDenylistCacheForTests();
    }
  });
});
