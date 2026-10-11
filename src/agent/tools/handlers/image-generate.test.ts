import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImageGenerateHandler } from './image-generate.js';
import { _resetWriteDenylistCacheForTests } from './write-denylist.js';
import { _resetRootRealpathCacheForTests } from './_cwd-utils.js';

// Mock resolveOpenAIAuth so tests control auth resolution without touching disk.
vi.mock('../../providers/openai-compatible/auth.js', () => ({
  resolveOpenAIAuth: vi.fn(() => ({ apiKey: null, source: 'no-usable-auth' })),
}));

// Mock the ChatGPT image module so tests control its behavior.
vi.mock('./image-generate.chatgpt.js', () => ({
  generateImageViaChatGpt: vi.fn(),
}));

import { resolveOpenAIAuth } from '../../providers/openai-compatible/auth.js';
import { generateImageViaChatGpt } from './image-generate.chatgpt.js';
const mockResolveAuth = vi.mocked(resolveOpenAIAuth);
const mockChatGptImage = vi.mocked(generateImageViaChatGpt);

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
  let tmpDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-image-gen-test-'));
    // Default: resolveOpenAIAuth returns no auth (tests that need it override).
    mockResolveAuth.mockReturnValue({ apiKey: null, source: 'no-usable-auth' });
    mockChatGptImage.mockReset();
  });

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Auth resolution ────────────────────────────────────────────────────

  it('returns error when no auth source is available', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'a cat' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('AFK_IMAGE_API_KEY');
    expect(result.content).toContain('OPENAI_API_KEY');
    expect(result.content).toContain('ChatGPT subscription OAuth');
    vi.unstubAllEnvs();
  });

  it('falls back to resolveOpenAIAuth when AFK_IMAGE_API_KEY is unset', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({ apiKey: 'sk-resolved', source: 'env', envVar: 'OPENAI_API_KEY' });
    const handler = createImageGenerateHandler();
    // Should NOT error on missing key — proceeds to input validation.
    const result = await handler({}, signal, { resolveBase: tmpDir, sessionId: 'fallback-auth-test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('prompt');
    expect(result.content).not.toContain('auth');
    vi.unstubAllEnvs();
  });

  it('prefers AFK_IMAGE_API_KEY over resolveOpenAIAuth', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'dedicated-key');
    mockResolveAuth.mockReturnValue({ apiKey: 'oauth-token', source: 'chatgpt-oauth' });
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    mockResolveAuth.mockClear(); // clear prior calls from other tests
    await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'pref-test' });
    // Should use the dedicated key, not the OAuth token.
    const [, opts] = fetchFn.mock.calls[0]!;
    expect(opts.headers['Authorization']).toBe('Bearer dedicated-key');
    // resolveOpenAIAuth should not be called when dedicated key exists.
    expect(mockResolveAuth).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  // PR #3388 pinning test: chatgpt-oauth → ChatGPT backend (not standard Images API)
  it('when auth resolves to chatgpt-oauth, image_generate routes through the ChatGPT backend (not the standard Images API)', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({
      apiKey: 'chatgpt-token',
      source: 'chatgpt-oauth',
      accountId: 'acct_pintest',
    });
    mockChatGptImage.mockResolvedValue({ b64_json: TINY_PNG_B64, revised_prompt: null });
    const directFetch = vi.fn(); // must NOT be called on the chatgpt-oauth path
    const handler = createImageGenerateHandler(directFetch);
    const result = await handler({ prompt: 'pin test' }, signal, { resolveBase: tmpDir, sessionId: 'pin-oauth' });
    expect(result.isError).toBeUndefined();
    expect(directFetch).not.toHaveBeenCalled(); // standard Images API bypassed
    expect(mockChatGptImage).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  it('routes ChatGPT OAuth through the subscription Responses endpoint', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({
      apiKey: 'chatgpt-access-token',
      source: 'chatgpt-oauth',
      accountId: 'acct_abc123',
    });
    mockChatGptImage.mockResolvedValue({
      b64_json: TINY_PNG_B64,
      revised_prompt: 'a revised prompt',
    });
    const fetchFn = vi.fn(); // should NOT be called directly
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'oauth-test' });

    expect(result.isError).toBeUndefined();
    // The direct fetchFn should NOT be called — ChatGPT path uses its own fetch.
    expect(fetchFn).not.toHaveBeenCalled();
    // generateImageViaChatGpt should be called with the right args.
    expect(mockChatGptImage).toHaveBeenCalledOnce();
    const args = mockChatGptImage.mock.calls[0]![0];
    expect(args.apiKey).toBe('chatgpt-access-token');
    expect(args.accountId).toBe('acct_abc123');
    expect(args.prompt).toBe('test');
    const meta = JSON.parse(result.content);
    expect(meta.auth_source).toBe('chatgpt-oauth');
    expect(meta.revised_prompt).toBe('a revised prompt');
    vi.unstubAllEnvs();
  });

  it('returns error when ChatGPT subscription path fails', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({
      apiKey: 'chatgpt-access-token',
      source: 'chatgpt-oauth',
      accountId: 'acct_abc123',
    });
    mockChatGptImage.mockResolvedValue({
      error: 'ChatGPT backend returned 429: usage limit reached',
    });
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'oauth-err' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('429');
    vi.unstubAllEnvs();
  });

  it('returns expired-token error for chatgpt-oauth-expired', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', '');
    mockResolveAuth.mockReturnValue({ apiKey: null, source: 'chatgpt-oauth-expired', expiresAt: 1 });
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'test' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('expired');
    expect(result.content).toContain('codex');
    vi.unstubAllEnvs();
  });

  // ── Input validation ────────────────────────────────────────────────────

  it('rejects missing prompt', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageGenerateHandler();
    const result = await handler({}, signal, { resolveBase: tmpDir, sessionId: 'val-prompt-test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('prompt');
    vi.unstubAllEnvs();
  });

  it('rejects invalid model', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'test', model: 'dall-e-3' }, signal, { resolveBase: tmpDir, sessionId: 'val-model-test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid model');
    vi.unstubAllEnvs();
  });

  it('rejects invalid size', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const handler = createImageGenerateHandler();
    const result = await handler({ prompt: 'test', size: '512x512' }, signal, { resolveBase: tmpDir, sessionId: 'val-size-test' });
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
    const result = await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'daemon-allow-test' });
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
    const ctx = { resolveBase: tmpDir, sessionId: sid };

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
      { resolveBase: tmpDir, sessionId: 'gen-test-session' },
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
      { resolveBase: tmpDir, sessionId: 'custom-path-session' },
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
    const result = await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'err-session' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('429');
    vi.unstubAllEnvs();
  });

  it('returns error on network failure', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'net-err-session' });
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
    const result = await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'no-data-session' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no image data');
    vi.unstubAllEnvs();
  });

  // ── inspect flag ────────────────────────────────────────────────────────

  it('returns image inline when inspect:true', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'a cat', inspect: true },
      signal,
      { resolveBase: tmpDir, sessionId: 'inspect-on-session' },
    );

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/png');
    expect(result.image?.data).toBe(TINY_PNG_B64);
    // Metadata is still in content
    const meta = JSON.parse(result.content);
    expect(meta.path).toMatch(/\.png$/);
    expect(meta.bytes).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });

  it('does not return image inline when inspect is omitted (default)', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'a cat' },
      signal,
      { resolveBase: tmpDir, sessionId: 'inspect-off-session' },
    );

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('does not return image inline when inspect:false', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'a cat', inspect: false },
      signal,
      { resolveBase: tmpDir, sessionId: 'inspect-false-session' },
    );

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('degrades gracefully when inspect:true and base64 payload exceeds 2MB cap', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    // Build a fake base64 string > 2MB
    const bigB64 = 'A'.repeat(2 * 1024 * 1024 + 1);
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(bigB64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'a cat', inspect: true },
      signal,
      { resolveBase: tmpDir, sessionId: 'inspect-cap-session' },
    );

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();
    const meta = JSON.parse(result.content);
    expect(meta.imageOmitted).toContain('exceeds the');
    vi.unstubAllEnvs();
  });

  it('sets correct media type for jpeg when inspect:true', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'a cat', output_format: 'jpeg', inspect: true },
      signal,
      { resolveBase: tmpDir, sessionId: 'inspect-jpeg-session' },
    );

    expect(result.isError).toBeUndefined();
    // If image is attached, check media type; otherwise check it was saved to disk
    if (result.image) {
      expect(result.image.mediaType).toBe('image/jpeg');
    } else {
      // dimensions or byte check degraded — still valid
      const meta = JSON.parse(result.content);
      expect(meta.path).toMatch(/\.jpeg$/);
    }
    vi.unstubAllEnvs();
  });

  // ── Default values ──────────────────────────────────────────────────────

  it('uses default model, size, quality, and format when not specified', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    await handler({ prompt: 'test' }, signal, { resolveBase: tmpDir, sessionId: 'defaults-session' });

    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.model).toBe('gpt-image-1');
    expect(body.size).toBe('1024x1024');
    expect(body.quality).toBe('auto');
    expect(body.output_format).toBe('png');
    vi.unstubAllEnvs();
  });

  // ── Dangling symlink security (#2823) ────────────────────────────────────

  it('refuses a dangling symlink whose target is outside the write root', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    _resetRootRealpathCacheForTests();
    _resetWriteDenylistCacheForTests();

    // Create an outside dir with an existing parent (the symlink target parent must
    // exist for the kernel to follow the link and write there).
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-outside-'));
    const outsideFile = path.join(outsideDir, 'escaped.png');
    const linkPath = path.join(tmpDir!, 'evil.png');
    // Dangling symlink: link exists inside root but target does not exist yet.
    fsSync.symlinkSync(outsideFile, linkPath);

    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', output_path: linkPath },
      signal,
      { cwd: tmpDir, sessionId: 'symlink-escape-test', resolveBase: tmpDir, writeRoots: [tmpDir!] },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside.*write roots|write roots/i);
    // The outside file must NOT have been created.
    await expect(fs.access(outsideFile)).rejects.toThrow();

    await fs.rm(outsideDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    _resetRootRealpathCacheForTests();
  });

  it('refuses a dangling symlink that points at a denylisted path', async () => {
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    _resetRootRealpathCacheForTests();
    _resetWriteDenylistCacheForTests();

    const homeDir = os.homedir();
    const denyTarget = path.join(homeDir, '.ssh', 'injected.png');
    const linkPath = path.join(tmpDir!, 'denylink.png');
    // Dangling symlink pointing at a denylisted path (~/.ssh/).
    fsSync.symlinkSync(denyTarget, linkPath);

    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
    const handler = createImageGenerateHandler(fetchFn);
    const result = await handler(
      { prompt: 'test', output_path: linkPath },
      signal,
      { cwd: tmpDir, sessionId: 'symlink-deny-test', resolveBase: tmpDir, writeRoots: [tmpDir!, homeDir] },
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
    // parent (root/subdir), so ../../ correctly escapes root. Without the fix
    // the lexical parent (root/dirLink) would be used, which may resolve
    // differently.
    vi.stubEnv('AFK_IMAGE_API_KEY', 'test-key');
    _resetRootRealpathCacheForTests();
    _resetWriteDenylistCacheForTests();

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-gen-outside-'));
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
      // Relative from subdir: go up to outsideDir then into outside/escaped.png.
      const relEscape = path.join(
        path.relative(subdir, path.dirname(outsideDir)),
        'outside',
        'escaped.png',
      );
      fsSync.symlinkSync(relEscape, path.join(subdir, 'hop.png'));

      // Access via the directory symlink.
      const accessPath = path.join(dirLink, 'hop.png');

      const fetchFn = vi.fn().mockResolvedValue(makeOkResponse(TINY_PNG_B64));
      const handler = createImageGenerateHandler(fetchFn);
      const result = await handler(
        { prompt: 'test', output_path: accessPath },
        signal,
        { cwd: tmpDir, sessionId: 'dirlink-escape-test', resolveBase: tmpDir, writeRoots: [tmpDir!] },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside.*write roots|write roots/i);
      // The outside file must NOT have been created by the handler.
      await expect(fs.access(escapedFile)).resolves.toBeUndefined(); // file exists (we created it)
      const stat = await fs.stat(escapedFile);
      expect(stat.size).toBe('sensitive'.length); // must not have grown
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
      _resetRootRealpathCacheForTests();
      _resetWriteDenylistCacheForTests();
    }
  });
});
