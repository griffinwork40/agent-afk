/**
 * Tests for `oneShotChatCompletion` (openai-compatible).
 *
 * Sibling of `anthropic-direct/oneshot.test.ts`. Uses the `clientFactory`
 * injection hook (and the module-scope `__setOpenAIOneShotClientFactory`
 * escape hatch) to avoid real SDK/network calls. `resolveOpenAIAuth` is mocked
 * so the auth-resolution outcome is deterministic regardless of the host env
 * (no OPENAI_API_KEY / ~/.codex/auth.json dependency).
 *
 * Coverage:
 *   - happy path: returns trimmed assistant message content
 *   - content null / missing / no choices → ''
 *   - forwards model, max_tokens (default 64 + override), system+user messages
 *   - emits `max_tokens` for chat models, `max_completion_tokens` for o-series
 *     (incl. provider/-prefixed ids) + stream:false
 *   - forwards baseURL to the client factory and the abort signal to create()
 *   - throws on auth-resolution failure (apiKey === null)
 *   - per-call clientFactory takes precedence over the module-scope hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { oneShotChatCompletion, __setOpenAIOneShotClientFactory } from './oneshot.js';
import type { OpenAIAuthResolution } from './auth.js';

// ── Auth mock ───────────────────────────────────────────────────────────────
// `oneShotChatCompletion` calls `resolveOpenAIAuth(apiKey)` without deps, so we
// mock the module to control the resolution outcome deterministically.
const { mockResolveAuth } = vi.hoisted(() => ({ mockResolveAuth: vi.fn() }));
vi.mock('./auth.js', () => ({ resolveOpenAIAuth: mockResolveAuth }));

// ── Minimal OpenAI client stub ────────────────────────────────────────────────

interface ChatCreateParams {
  model: string;
  max_tokens?: number;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
  max_completion_tokens?: number;
}
type ChatCreateFn = (
  params: ChatCreateParams,
  options?: { signal?: AbortSignal },
) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;

function makeClient(createFn: ChatCreateFn): OpenAI {
  return { chat: { completions: { create: createFn } } } as unknown as OpenAI;
}

function okAuth(apiKey: string): OpenAIAuthResolution {
  return { apiKey, source: 'config' };
}

describe('oneShotChatCompletion', () => {
  beforeEach(() => {
    // Default: a usable key derived from the explicit arg (or a placeholder).
    mockResolveAuth.mockImplementation((explicit?: string) =>
      okAuth(explicit && explicit.length > 0 ? explicit : 'env-test-key'),
    );
  });

  afterEach(() => {
    __setOpenAIOneShotClientFactory(null);
    vi.clearAllMocks();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it('returns the assistant message content', async () => {
    const result = await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({
        choices: [{ message: { content: 'list files' } }],
      })),
    });
    expect(result).toBe('list files');
  });

  it('trims leading/trailing whitespace from the content', async () => {
    const result = await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({
        choices: [{ message: { content: '  list files  ' } }],
      })),
    });
    expect(result).toBe('list files');
  });

  it('returns empty string when content is null', async () => {
    const result = await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({
        choices: [{ message: { content: null } }],
      })),
    });
    expect(result).toBe('');
  });

  it('returns empty string when there are no choices', async () => {
    const result = await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({ choices: [] })),
    });
    expect(result).toBe('');
  });

  it('returns empty string when the message is missing', async () => {
    const result = await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({ choices: [{}] })),
    });
    expect(result).toBe('');
  });

  // ── request shape ───────────────────────────────────────────────────────────

  it('forwards model, system+user messages, stream:false and default max_tokens (64)', async () => {
    let captured: ChatCreateParams | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'system prompt',
      user: 'user content',
      clientFactory: () => makeClient(async (params) => {
        captured = params;
        return { choices: [{ message: { content: 'ok' } }] };
      }),
    });
    expect(captured?.model).toBe('gpt-4o-mini');
    expect(captured?.stream).toBe(false);
    expect(captured?.max_tokens).toBe(64);
    expect(captured?.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user content' },
    ]);
  });

  it('honors the maxTokens override', async () => {
    let captured: ChatCreateParams | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      maxTokens: 24,
      clientFactory: () => makeClient(async (params) => {
        captured = params;
        return { choices: [{ message: { content: 'ok' } }] };
      }),
    });
    expect(captured?.max_tokens).toBe(24);
  });

  it('emits `max_tokens` (not `max_completion_tokens`) for chat models', async () => {
    let captured: ChatCreateParams | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async (params) => {
        captured = params;
        return { choices: [{ message: { content: 'ok' } }] };
      }),
    });
    expect(captured && 'max_tokens' in captured).toBe(true);
    expect(captured?.max_completion_tokens).toBeUndefined();
  });

  it('emits `max_completion_tokens` (not `max_tokens`) for the o-series', async () => {
    let captured: ChatCreateParams | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'o3-mini',
      system: 'sys',
      user: 'msg',
      maxTokens: 32,
      clientFactory: () => makeClient(async (params) => {
        captured = params;
        return { choices: [{ message: { content: 'ok' } }] };
      }),
    });
    expect(captured?.max_completion_tokens).toBe(32);
    expect(captured && 'max_tokens' in captured).toBe(false);
  });

  it('strips a `provider/` prefix when detecting the o-series', async () => {
    let captured: ChatCreateParams | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'openai/o4-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async (params) => {
        captured = params;
        return { choices: [{ message: { content: 'ok' } }] };
      }),
    });
    expect(captured?.max_completion_tokens).toBe(64);
    expect(captured && 'max_tokens' in captured).toBe(false);
  });

  it('forwards the abort signal to chat.completions.create', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      signal: controller.signal,
      clientFactory: () => makeClient(async (_params, options) => {
        capturedSignal = options?.signal;
        return { choices: [{ message: { content: 'ok' } }] };
      }),
    });
    expect(capturedSignal).toBe(controller.signal);
  });

  it('forwards baseURL to the client factory', async () => {
    let capturedOpts: { apiKey: string; baseURL?: string } | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      baseURL: 'http://localhost:8080/v1',
      model: 'local-model',
      system: 'sys',
      user: 'msg',
      clientFactory: (opts) => {
        capturedOpts = opts;
        return makeClient(async () => ({ choices: [{ message: { content: 'ok' } }] }));
      },
    });
    expect(capturedOpts?.baseURL).toBe('http://localhost:8080/v1');
    expect(capturedOpts?.apiKey).toBe('sk-test');
  });

  it('omits baseURL from client opts when not provided', async () => {
    let capturedOpts: { apiKey: string; baseURL?: string } | undefined;
    await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: (opts) => {
        capturedOpts = opts;
        return makeClient(async () => ({ choices: [{ message: { content: 'ok' } }] }));
      },
    });
    expect(capturedOpts && 'baseURL' in capturedOpts).toBe(false);
  });

  // ── auth ──────────────────────────────────────────────────────────────────

  it('throws when auth resolution yields no usable key', async () => {
    mockResolveAuth.mockReturnValueOnce({ apiKey: null, source: 'no-usable-auth' });
    await expect(
      oneShotChatCompletion({
        model: 'gpt-4o-mini',
        system: 'sys',
        user: 'msg',
        clientFactory: () => makeClient(async () => ({ choices: [{ message: { content: 'ok' } }] })),
      }),
    ).rejects.toThrow(/no usable OpenAI auth/);
  });

  it('passes the explicit apiKey through to resolveOpenAIAuth', async () => {
    await oneShotChatCompletion({
      apiKey: 'sk-explicit',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({ choices: [{ message: { content: 'ok' } }] })),
    });
    expect(mockResolveAuth).toHaveBeenCalledWith('sk-explicit');
  });

  // ── factory precedence ──────────────────────────────────────────────────────

  it('per-call clientFactory takes precedence over the module-scope hook', async () => {
    const hookCalled = vi.fn();
    const argCalled = vi.fn();
    __setOpenAIOneShotClientFactory(() => {
      hookCalled();
      return makeClient(async () => ({ choices: [{ message: { content: 'from-hook' } }] }));
    });

    const result = await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
      clientFactory: () => {
        argCalled();
        return makeClient(async () => ({ choices: [{ message: { content: 'from-arg' } }] }));
      },
    });

    expect(result).toBe('from-arg');
    expect(argCalled).toHaveBeenCalledTimes(1);
    expect(hookCalled).not.toHaveBeenCalled();
  });

  it('falls back to the module-scope hook when no per-call factory is given', async () => {
    __setOpenAIOneShotClientFactory(() =>
      makeClient(async () => ({ choices: [{ message: { content: 'from-hook' } }] })),
    );
    const result = await oneShotChatCompletion({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'msg',
    });
    expect(result).toBe('from-hook');
  });
});
