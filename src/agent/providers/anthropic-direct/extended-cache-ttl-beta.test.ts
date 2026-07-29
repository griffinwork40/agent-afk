/**
 * Regression tests: a request that stamps `ttl: '1h'` must also negotiate the
 * `extended-cache-ttl-2025-04-11` beta — in API-KEY mode, not just OAuth.
 *
 * Before the fix `buildRequestHeaders` returned `{}` for every non-oauth mode
 * while `cache-policy.ts` unconditionally stamped `TTL_DEFAULT = '1h'`, so
 * API-key sessions asked for a 1-hour cache the server silently downgraded to
 * the 5-minute default. The header and the stamped TTL are now derived from one
 * predicate (`isExtendedCacheTtlActive`) so they cannot diverge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from './index.js';
import {
  buildRequestHeaders,
  EXTENDED_CACHE_TTL_BETA,
  OAUTH_BETA_HEADER,
  CLI_USER_AGENT,
} from './auth.js';
import { isExtendedCacheTtlActive, getCacheTtl } from './cache-policy.js';

// --- unit: the header builder ---

describe('buildRequestHeaders — extended-cache-ttl beta in api-key mode', () => {
  it('sends the beta in api-key mode when a 1h breakpoint is stamped', () => {
    const headers = buildRequestHeaders('api-key', 'sid', 'rid', false, true);
    expect(headers['anthropic-beta']).toBe(EXTENDED_CACHE_TTL_BETA);
  });

  it('sends ONLY the beta in api-key mode — no cli-mimicry headers', () => {
    const headers = buildRequestHeaders('api-key', 'sid', 'rid', false, true);
    expect(headers['x-app']).toBeUndefined();
    expect(headers['User-Agent']).toBeUndefined();
    expect(headers['X-Claude-Code-Session-Id']).toBeUndefined();
    expect(Object.keys(headers)).toEqual(['anthropic-beta']);
  });

  it('omits all headers in api-key mode when no 1h breakpoint is stamped', () => {
    expect(buildRequestHeaders('api-key', 'sid', 'rid', false, false)).toEqual({});
    expect(buildRequestHeaders('api-key', 'sid', 'rid')).toEqual({});
  });

  it('OAuth headers are unchanged and still carry the beta', () => {
    const headers = buildRequestHeaders('oauth', 'sid', 'rid', false, true);
    expect(headers['anthropic-beta']).toBe(OAUTH_BETA_HEADER);
    expect(headers['anthropic-beta']).toContain(EXTENDED_CACHE_TTL_BETA);
    expect(headers['User-Agent']).toBe(CLI_USER_AGENT);
  });
});

// --- unit: the coupling predicate ---

describe('isExtendedCacheTtlActive', () => {
  const origTtl = process.env['AFK_PROMPT_CACHE_TTL'];
  const origOff = process.env['AFK_DISABLE_PROMPT_CACHE'];
  afterEach(() => {
    if (origTtl === undefined) delete process.env['AFK_PROMPT_CACHE_TTL'];
    else process.env['AFK_PROMPT_CACHE_TTL'] = origTtl;
    if (origOff === undefined) delete process.env['AFK_DISABLE_PROMPT_CACHE'];
    else process.env['AFK_DISABLE_PROMPT_CACHE'] = origOff;
  });

  it('is true by default (TTL_DEFAULT is 1h and cache is on)', () => {
    delete process.env['AFK_PROMPT_CACHE_TTL'];
    delete process.env['AFK_DISABLE_PROMPT_CACHE'];
    expect(getCacheTtl()).toBe('1h');
    expect(isExtendedCacheTtlActive()).toBe(true);
  });

  it('is false when the TTL is explicitly 5m (no beta needed)', () => {
    process.env['AFK_PROMPT_CACHE_TTL'] = '5m';
    expect(isExtendedCacheTtlActive()).toBe(false);
  });

  it('is false when caching is disabled (nothing is stamped)', () => {
    delete process.env['AFK_PROMPT_CACHE_TTL'];
    process.env['AFK_DISABLE_PROMPT_CACHE'] = '1';
    expect(isExtendedCacheTtlActive()).toBe(false);
  });

  it('is false in local-shim mode, keeping shim requests header-free', () => {
    delete process.env['AFK_PROMPT_CACHE_TTL'];
    delete process.env['AFK_DISABLE_PROMPT_CACHE'];
    expect(isExtendedCacheTtlActive({ baseUrl: 'http://127.0.0.1:11434' })).toBe(false);
  });
});

// --- wire-level: an api-key session actually puts the beta on the request ---

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor(_opts: unknown) {
    this.messages = { create: messagesCreateMock };
  }
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_ttl_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 3,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

describe('api-key session — 1h TTL request carries the activating beta', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(
      (opts) => new MockAnthropic(opts) as unknown as Anthropic,
    );
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  it('stamps ttl:1h AND sends extended-cache-ttl with a plain sk-ant-api key', async () => {
    const captured: {
      headers: Record<string, string> | undefined;
      params: Record<string, unknown>;
    }[] = [];
    messagesCreateMock.mockImplementation(
      (
        params: Record<string, unknown>,
        opts: { headers?: Record<string, string> } | undefined,
      ) => {
        captured.push({ headers: opts?.headers, params });
        return fromArray(makeTextStream('hi'));
      },
    );

    const provider = new AnthropicDirectProvider();
    await collect(
      provider.query({
        prompt: singleInput('hello'),
        config: {
          model: 'claude-sonnet-4-5',
          apiKey: 'sk-ant-api03-FAKE-not-an-oauth-token',
        } as never,
      }),
    );

    expect(captured.length).toBeGreaterThan(0);
    const first = captured[0]!;

    // The request really does ask for a 1-hour cache...
    const system = first.params['system'] as
      | { cache_control?: { ttl?: string } }[]
      | undefined;
    const stampedTtls = (system ?? [])
      .map((b) => b.cache_control?.ttl)
      .filter((t): t is string => typeof t === 'string');
    expect(stampedTtls).toContain('1h');

    // ...so the beta that activates it must be on the wire. This is the
    // assertion that failed before the fix (headers were `{}`).
    expect(first.headers?.['anthropic-beta']).toBeDefined();
    expect(first.headers?.['anthropic-beta']).toContain(EXTENDED_CACHE_TTL_BETA);

    // api-key mode still sends no OAuth identity headers.
    expect(first.headers?.['x-app']).toBeUndefined();
    expect(first.headers?.['User-Agent']).toBeUndefined();
  });
});
