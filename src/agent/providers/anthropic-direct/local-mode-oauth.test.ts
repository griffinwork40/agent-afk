/**
 * Regression tests: OAuth CLI-mimicry headers must NOT reach a local shim.
 *
 * If a user sets AFK_LOCAL_API_KEY=sk-ant-oat01-... (an OAuth-shaped token),
 * detectAuthMode returns 'oauth', which previously caused anthropic-beta,
 * x-app, User-Agent, and X-Claude-Code-Session-Id to be emitted to the local
 * server. These are identity-surface headers that only make sense on
 * api.anthropic.com and should be suppressed in local-server mode.
 *
 * Fix location: src/agent/providers/anthropic-direct/index.ts — the
 * AnthropicDirectQuery is now constructed with `authMode: 'api-key'` when
 * localMode is true, regardless of the token shape.
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
  OAUTH_BETA_HEADER,
  CLI_USER_AGENT,
} from './auth.js';

// --- Mock SDK plumbing (mirrors query-auth-retry.test.ts pattern) ---

type CreateArgs = [
  Record<string, unknown>,
  { headers?: Record<string, string>; signal?: AbortSignal } | undefined,
];

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
        id: 'msg_local_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'local-model',
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

describe('AnthropicDirectProvider — local-mode OAuth header suppression', () => {
  const FAKE_OAUTH_TOKEN = 'sk-ant-oat01-FAKE-local-test';
  const LOCAL_BASE_URL = 'http://127.0.0.1:11434';

  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    __setAnthropicClientFactory(
      (opts) => new MockAnthropic(opts) as unknown as Anthropic,
    );
    messagesCreateMock.mockImplementation(() =>
      fromArray(makeTextStream('local response')),
    );
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  it('does not emit OAuth CLI-mimicry headers when AFK_LOCAL_API_KEY is an oauth-shaped token and baseUrl is set', async () => {
    const capturedHeadersList: Record<string, string>[] = [];
    messagesCreateMock.mockImplementation(
      (_params: unknown, opts: { headers?: Record<string, string> } | undefined) => {
        if (opts?.headers) capturedHeadersList.push(opts.headers);
        return fromArray(makeTextStream('local response'));
      },
    );

    const origEnv = process.env['AFK_LOCAL_API_KEY'];
    process.env['AFK_LOCAL_API_KEY'] = FAKE_OAUTH_TOKEN;
    try {
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('hello'),
        config: {
          model: 'local-model',
          baseUrl: LOCAL_BASE_URL,
        } as never,
      });
      await collect(query);
    } finally {
      if (origEnv === undefined) {
        delete process.env['AFK_LOCAL_API_KEY'];
      } else {
        process.env['AFK_LOCAL_API_KEY'] = origEnv;
      }
    }

    // At least one request must have been made.
    expect(messagesCreateMock).toHaveBeenCalled();

    // None of the captured header objects may contain OAuth CLI-mimicry headers.
    for (const headers of capturedHeadersList) {
      expect(headers['anthropic-beta']).not.toBe(OAUTH_BETA_HEADER);
      expect(headers['x-app']).toBeUndefined();
      expect(headers['User-Agent']).not.toBe(CLI_USER_AGENT);
      expect(headers['X-Claude-Code-Session-Id']).toBeUndefined();
    }
  });

  it('does not emit OAuth system-prefix when AFK_LOCAL_API_KEY is oauth-shaped and baseUrl is set', async () => {
    const capturedSystemBlocks: unknown[] = [];
    messagesCreateMock.mockImplementation(
      (params: { system?: unknown }, _opts: unknown) => {
        if (params.system !== undefined) capturedSystemBlocks.push(params.system);
        return fromArray(makeTextStream('local response'));
      },
    );

    const origEnv = process.env['AFK_LOCAL_API_KEY'];
    process.env['AFK_LOCAL_API_KEY'] = FAKE_OAUTH_TOKEN;
    try {
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('hello'),
        config: {
          model: 'local-model',
          baseUrl: LOCAL_BASE_URL,
        } as never,
      });
      await collect(query);
    } finally {
      if (origEnv === undefined) {
        delete process.env['AFK_LOCAL_API_KEY'];
      } else {
        process.env['AFK_LOCAL_API_KEY'] = origEnv;
      }
    }

    // The system array must not contain any OAuth billing-header prefix block.
    // In local mode the system param may be a string (never the prefix array).
    for (const system of capturedSystemBlocks) {
      if (Array.isArray(system)) {
        const texts = (system as Array<{ type: string; text: string }>)
          .filter((b) => b.type === 'text')
          .map((b) => b.text);
        // The billing header text (BILLING_HEADER_TEXT) should not appear.
        for (const t of texts) {
          expect(t).not.toContain('claude-subscription');
        }
      }
    }
  });

  it('does not install tokenRefresher in local mode even with oauth-shaped token', async () => {
    // Regression: a 401 from a local shim must not trigger a real-keychain
    // OAuth refresh whose freshly-minted Anthropic token would then be sent
    // to the local server. The refresher should be absent entirely in
    // local-server mode, regardless of token shape.
    const origEnv = process.env['AFK_LOCAL_API_KEY'];
    process.env['AFK_LOCAL_API_KEY'] = FAKE_OAUTH_TOKEN;
    try {
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('hello'),
        config: {
          model: 'local-model',
          baseUrl: LOCAL_BASE_URL,
        } as never,
      });
      const queryAny = query as unknown as {
        retry: { tokenRefresher?: () => Promise<Anthropic | null> };
      };
      expect(queryAny.retry.tokenRefresher).toBeUndefined();
    } finally {
      if (origEnv === undefined) {
        delete process.env['AFK_LOCAL_API_KEY'];
      } else {
        process.env['AFK_LOCAL_API_KEY'] = origEnv;
      }
    }
  });

  it('still uses api-key auth headers for standard token in local mode', async () => {
    const capturedHeadersList: Record<string, string>[] = [];
    messagesCreateMock.mockImplementation(
      (_params: unknown, opts: { headers?: Record<string, string> } | undefined) => {
        if (opts?.headers) capturedHeadersList.push(opts.headers);
        return fromArray(makeTextStream('ok'));
      },
    );

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'local-model',
        apiKey: 'local-plaintext-key',
        baseUrl: LOCAL_BASE_URL,
      } as never,
    });
    await collect(query);

    expect(messagesCreateMock).toHaveBeenCalled();
    // With a plain api-key token in local mode, no OAuth headers either.
    for (const headers of capturedHeadersList) {
      expect(headers['anthropic-beta']).toBeUndefined();
      expect(headers['x-app']).toBeUndefined();
    }
  });
});
