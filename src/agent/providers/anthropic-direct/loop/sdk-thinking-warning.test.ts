import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { isSdkThinkingDeprecationWarning, withoutSdkThinkingDeprecationWarning } from './sdk-thinking-warning.js';

afterEach(() => vi.restoreAllMocks());

function clientCapturingBody(): { client: Anthropic; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { type: 'x', message: 'stub' } }), { status: 400 });
    }) as unknown as typeof fetch,
  });
  return { client, bodies };
}

const params = {
  model: 'claude-opus-4-6',
  max_tokens: 4096,
  thinking: { type: 'enabled' as const, budget_tokens: 2048 },
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('withoutSdkThinkingDeprecationWarning', () => {
  it('the real SDK warns for opus-4-6 + enabled thinking (guards against an SDK change making this dead code)', async () => {
    // NOTE: if this test breaks after an SDK version bump that drops the
    // deprecation warning, the breakage is INTENTIONAL — it means the
    // `withoutSdkThinkingDeprecationWarning` wrapper has become dead code and
    // can be removed together with its callers.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = clientCapturingBody();
    await client.messages.create(params).catch(() => {});
    expect(warn.mock.calls.some((c) => isSdkThinkingDeprecationWarning(c))).toBe(true);
  });

  it('suppresses the warning while still sending thinking.type=enabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, bodies } = clientCapturingBody();
    await withoutSdkThinkingDeprecationWarning(() => client.messages.create(params)).catch(() => {});
    expect(warn.mock.calls.some((c) => isSdkThinkingDeprecationWarning(c))).toBe(false);
    expect((bodies[0] as { thinking: { type: string } }).thinking.type).toBe('enabled');
  });

  it('passes other warnings through and restores console.warn afterwards', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = console.warn;
    withoutSdkThinkingDeprecationWarning(() => console.warn('unrelated warning'));
    expect(warn).toHaveBeenCalledWith('unrelated warning');
    expect(console.warn).toBe(before);
  });

  it('restores console.warn when fn throws', () => {
    const before = console.warn;
    expect(() => withoutSdkThinkingDeprecationWarning(() => { throw new Error('boom'); })).toThrow('boom');
    expect(console.warn).toBe(before);
  });
});
