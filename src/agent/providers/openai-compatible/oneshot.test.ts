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
import { oneShotChatCompletion, oneShotResponses, __setOpenAIOneShotClientFactory } from './oneshot.js';
import type { OpenAIAuthResolution } from './auth.js';
import type { ResponsesStreamEvent } from './responses-translate.js';

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

// ── oneShotResponses (Responses wire — issue #653) ────────────────────────────

interface ResponsesCreateParams {
  model: string;
  input: unknown;
  stream?: boolean;
  instructions?: string;
  store?: boolean;
  max_output_tokens?: number;
  tools?: unknown[];
}
type ResponsesCreateFn = (
  params: ResponsesCreateParams,
  options?: { signal?: AbortSignal },
) => Promise<AsyncIterable<ResponsesStreamEvent>> | AsyncIterable<ResponsesStreamEvent>;

/** A client exposing only `responses.create` — oneShotResponses uses it verbatim. */
function makeResponsesClient(createFn: ResponsesCreateFn): OpenAI {
  return { responses: { create: createFn } } as unknown as OpenAI;
}

/** Async generator over a fixed list of Responses stream events. */
function streamOf(...events: ResponsesStreamEvent[]): AsyncIterable<ResponsesStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

describe('oneShotResponses', () => {
  it('accumulates output_text.delta events and returns the trimmed text', async () => {
    const result = await oneShotResponses({
      client: makeResponsesClient(() =>
        streamOf(
          { type: 'response.output_text.delta', delta: '  first ' },
          { type: 'response.output_text.delta', delta: 'second  ' },
          { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
        ),
      ),
      model: 'gpt-5.5',
      system: 'sys',
      user: 'transcript',
      isChatGptBackend: false,
    });
    // Deltas concatenated verbatim, then trimmed at the ends only.
    expect(result).toBe('first second');
  });

  it('awaits a promise-returning create (SDK APIPromise) and drains it', async () => {
    const result = await oneShotResponses({
      client: makeResponsesClient(async () =>
        streamOf({ type: 'response.output_text.delta', delta: 'ok' }),
      ),
      model: 'gpt-5.5',
      system: 'sys',
      user: 'transcript',
      isChatGptBackend: false,
    });
    expect(result).toBe('ok');
  });

  it('sends stream:true, the model, no tools, and the system prompt as instructions', async () => {
    let captured: ResponsesCreateParams | undefined;
    await oneShotResponses({
      client: makeResponsesClient((params) => {
        captured = params;
        return streamOf({ type: 'response.output_text.delta', delta: 'x' });
      }),
      model: 'gpt-4o',
      system: 'COMPACT-SYS',
      user: 'the transcript',
      isChatGptBackend: false,
    });
    expect(captured?.model).toBe('gpt-4o');
    expect(captured?.stream).toBe(true);
    expect(captured?.instructions).toBe('COMPACT-SYS');
    // A summarize advertises no tools.
    expect(captured?.tools).toBeUndefined();
    // Public API-key path carries the output cap.
    expect(captured?.max_output_tokens).toBeDefined();
    expect(captured?.store).toBeUndefined();
  });

  it('on the ChatGPT backend: omits max_output_tokens and sets store:false', async () => {
    let captured: ResponsesCreateParams | undefined;
    await oneShotResponses({
      client: makeResponsesClient((params) => {
        captured = params;
        return streamOf({ type: 'response.output_text.delta', delta: 'x' });
      }),
      model: 'gpt-5.5',
      system: 'COMPACT-SYS',
      user: 'the transcript',
      isChatGptBackend: true,
    });
    // The ChatGPT/Codex backend 400s on any output-cap param, and needs store:false.
    expect(captured && 'max_output_tokens' in captured).toBe(false);
    expect(captured?.store).toBe(false);
    expect(captured?.instructions).toBe('COMPACT-SYS');
  });

  it('forwards the abort signal to responses.create', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    await oneShotResponses({
      client: makeResponsesClient((_params, options) => {
        capturedSignal = options?.signal;
        return streamOf({ type: 'response.output_text.delta', delta: 'x' });
      }),
      model: 'gpt-5.5',
      system: 'sys',
      user: 'msg',
      isChatGptBackend: true,
      signal: controller.signal,
    });
    expect(capturedSignal).toBe(controller.signal);
  });

  it('returns empty string when the stream carries no text', async () => {
    const result = await oneShotResponses({
      client: makeResponsesClient(() =>
        streamOf({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }),
      ),
      model: 'gpt-5.5',
      system: 'sys',
      user: 'msg',
      isChatGptBackend: true,
    });
    expect(result).toBe('');
  });

  it('propagates a create() error (caller/compaction core treats it as a safe no-op)', async () => {
    await expect(
      oneShotResponses({
        client: makeResponsesClient(() => {
          throw new Error('backend rejected');
        }),
        model: 'gpt-5.5',
        system: 'sys',
        user: 'msg',
        isChatGptBackend: true,
      }),
    ).rejects.toThrow(/backend rejected/);
  });
});
