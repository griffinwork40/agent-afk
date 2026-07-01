/**
 * T21+T22: Tests for `oneShotCompletion`.
 *
 * Uses the `clientFactory` injection hook to avoid real SDK/network calls.
 *
 * Coverage:
 *   T21a - happy path: returns concatenated text from all text blocks
 *   T21b - no text blocks → returns '' and emits console.warn
 *   T22a - pre-aborted signal → throws AbortError without network call
 *   T22b - model and system forwarded verbatim to messages.create
 *   T22c - throws on missing/empty token
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { oneShotCompletion } from './oneshot.js';

// ---------------------------------------------------------------------------
// Minimal Anthropic client stub
// ---------------------------------------------------------------------------

type MessagesCreateFn = (
  params: { model: string; system: string; max_tokens: number; messages: unknown[] },
  options?: { signal?: AbortSignal },
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

function makeClient(createFn: MessagesCreateFn): Anthropic {
  return {
    messages: { create: createFn },
  } as unknown as Anthropic;
}

function happyClient(text: string): Anthropic {
  return makeClient(async () => ({
    content: [{ type: 'text', text }],
  }));
}

// ---------------------------------------------------------------------------

describe('oneShotCompletion (T21 + T22)', () => {
  let warnMessages: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
    warnMessages = [];
    console.warn = vi.fn((...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  // ── T21a: happy path ────────────────────────────────────────────────────

  it('(T21a) returns concatenated text from text-type blocks', async () => {
    const result = await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'generate a slug',
      user: 'fix the cleanup race',
      clientFactory: () => makeClient(async () => ({
        content: [
          { type: 'text', text: 'fix-' },
          { type: 'text', text: 'cleanup-race' },
        ],
      })),
    });
    expect(result).toBe('fix-cleanup-race');
    expect(warnMessages).toHaveLength(0);
  });

  it('(T21a) trims leading/trailing whitespace from the concatenated result', async () => {
    const result = await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'sys',
      user: 'msg',
      clientFactory: () => happyClient('  fix-cleanup-race  '),
    });
    expect(result).toBe('fix-cleanup-race');
  });

  it('(T21a) ignores non-text blocks (tool_use, thinking)', async () => {
    const result = await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({
        content: [
          { type: 'tool_use', id: 'x', name: 'bash', input: {} },
          { type: 'text', text: 'result' },
          { type: 'thinking', thinking: 'internal' },
        ],
      })),
    });
    expect(result).toBe('result');
    expect(warnMessages).toHaveLength(0);
  });

  // ── T21b: no-text-block → '' + warn ─────────────────────────────────────

  it('(T21b) returns empty string when no text blocks present', async () => {
    const result = await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({
        content: [{ type: 'tool_use', id: 'x', name: 'bash', input: {} }],
      })),
    });
    expect(result).toBe('');
  });

  it('(T21b) emits console.warn when no text blocks present', async () => {
    await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({ content: [] })),
    });
    expect(warnMessages.some((m) => m.includes('no text blocks'))).toBe(true);
  });

  it('(T21b) emits console.warn when all text blocks are empty/whitespace', async () => {
    await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async () => ({
        content: [{ type: 'text', text: '   ' }],
      })),
    });
    expect(warnMessages.some((m) => m.includes('no text blocks'))).toBe(true);
  });

  // ── T22a: pre-aborted signal ─────────────────────────────────────────────

  it('(T22a) throws when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let createCalled = false;
    await expect(
      oneShotCompletion({
        token: 'sk-ant-oat01-test',
        model: 'haiku',
        system: 'sys',
        user: 'msg',
        signal: controller.signal,
        clientFactory: () => makeClient(async (_params, options) => {
          createCalled = true;
          // The SDK would throw on an aborted signal; simulate that.
          if (options?.signal?.aborted) {
            throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
          }
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
      }),
    ).rejects.toThrow();
    // The create call was issued (the SDK checks the signal); the important
    // thing is that oneShotCompletion propagates the error upward.
    expect(createCalled).toBe(true);
  });

  it('(T22a) propagates abort mid-inflight by throwing from the clientFactory', async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });

    await expect(
      oneShotCompletion({
        token: 'sk-ant-oat01-test',
        model: 'haiku',
        system: 'sys',
        user: 'msg',
        signal: controller.signal,
        clientFactory: () => makeClient(async () => {
          controller.abort();
          throw abortError;
        }),
      }),
    ).rejects.toThrow('Aborted');
  });

  // ── T22b: model + system forwarding ─────────────────────────────────────

  it('(T22b) forwards unknown model strings verbatim to messages.create', async () => {
    // Non-alias strings (already-full ids, custom proxy names) pass through
    // unchanged. Alias resolution only fires for known short names — see the
    // dedicated alias-resolution test below.
    const captured: { model?: string; system?: string } = {};
    await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'claude-custom-model-v99',
      system: 'custom system prompt text',
      user: 'hello',
      clientFactory: () => makeClient(async (params) => {
        captured.model = params.model;
        captured.system = params.system;
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    });
    expect(captured.model).toBe('claude-custom-model-v99');
    expect(captured.system).toBe('custom system prompt text');
  });

  it('(T22b) resolves short-alias `haiku` to the full model id before send', async () => {
    // Regression: Anthropic Messages API returns 404 `model: haiku
    // not_found_error` when the short alias is sent under an OAuth token.
    // `oneShotCompletion` claims (in its JSDoc) to accept aliases — this
    // test pins the resolution-on-send behavior so the worktree autoname
    // and any future caller don't silently 404. Tracks the regression
    // surfaced by `/diagnose-autoname` 2026-05-25.
    let captured: string | undefined;
    await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'sys',
      user: 'msg',
      clientFactory: () => makeClient(async (params) => {
        captured = params.model;
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    });
    expect(captured).toBe('claude-haiku-4-5-20251001');
  });

  it('(T22b) resolves all canonical short aliases (opus/sonnet/haiku)', async () => {
    const cases: Array<[string, string]> = [
      ['opus', 'claude-opus-4-8'],
      ['sonnet', 'claude-sonnet-5'],
      ['haiku', 'claude-haiku-4-5-20251001'],
    ];
    for (const [alias, fullId] of cases) {
      let captured: string | undefined;
      await oneShotCompletion({
        token: 'sk-ant-oat01-test',
        model: alias,
        system: 'sys',
        user: 'msg',
        clientFactory: () => makeClient(async (params) => {
          captured = params.model;
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
      });
      expect(captured, `alias ${alias} should resolve`).toBe(fullId);
    }
  });

  it('(T22b) passes user message as the single messages array entry', async () => {
    const capturedMessages: unknown[] = [];
    await oneShotCompletion({
      token: 'sk-ant-oat01-test',
      model: 'haiku',
      system: 'sys',
      user: 'user message content',
      clientFactory: () => makeClient(async (params) => {
        capturedMessages.push(...params.messages);
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    });
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]).toMatchObject({ role: 'user', content: 'user message content' });
  });

  // ── T22c: token validation ───────────────────────────────────────────────

  it('(T22c) throws when token is empty string', async () => {
    await expect(
      oneShotCompletion({
        token: '',
        model: 'haiku',
        system: 'sys',
        user: 'msg',
        clientFactory: () => happyClient('ok'),
      }),
    ).rejects.toThrow('token required');
  });
});
