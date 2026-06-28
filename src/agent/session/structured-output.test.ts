/**
 * Tests for main-turn structured output: `AgentSession.sendMessageStructured`
 * and the `queryStructured` library wrapper (Claude Agent SDK parity, Dim 16).
 *
 * Uses the shared mock ModelProvider. The mock echoes `Echo: <prompt>` by
 * default, so a prompt containing valid JSON round-trips through
 * `extractStructuredOutput`; the `respond` hook drives SEQUENCED responses for
 * the retry path.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { AgentSession } from '../session.js';
import { queryStructured } from '../query.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

const NAME_SCHEMA = z.object({ name: z.string() });

describe('AgentSession.sendMessageStructured()', () => {
  it('parses and returns the assistant JSON on first attempt', async () => {
    const provider = createMockProvider({ respond: () => '{"name":"world"}' });
    const session = new AgentSession({ model: 'sonnet', provider, apiKey: 'test-key' });
    try {
      const out = await session.sendMessageStructured('{"name":"world"}', NAME_SCHEMA);
      expect(out).toEqual({ name: 'world' });
    } finally {
      await session.close();
    }
  });

  it('re-prompts on a schema mismatch and returns the corrected output', async () => {
    let turns = 0;
    const provider = createMockProvider({
      onTurn: () => {
        turns++;
      },
      respond: (_turn, index) => (index === 0 ? 'no json here' : '{"name":"ok"}'),
    });
    const session = new AgentSession({ model: 'sonnet', provider, apiKey: 'test-key' });
    try {
      const out = await session.sendMessageStructured('give me json', NAME_SCHEMA);
      expect(out).toEqual({ name: 'ok' });
      expect(turns).toBe(2); // first attempt failed, one retry succeeded
    } finally {
      await session.close();
    }
  });

  it('throws after exhausting the retry budget', async () => {
    let turns = 0;
    const provider = createMockProvider({
      onTurn: () => {
        turns++;
      },
      respond: () => 'never valid json',
    });
    const session = new AgentSession({ model: 'sonnet', provider, apiKey: 'test-key' });
    try {
      await expect(
        session.sendMessageStructured('x', NAME_SCHEMA, { maxRetries: 1 }),
      ).rejects.toThrow(/did not match schema after 2 attempt/);
      expect(turns).toBe(2); // maxRetries: 1 => exactly 2 model turns
    } finally {
      await session.close();
    }
  });

  it('injects the JSON schema into the first-attempt prompt by default', async () => {
    const prompts: string[] = [];
    const provider = createMockProvider({
      respond: (turn) => {
        prompts.push(typeof turn.content === 'string' ? turn.content : '');
        return '{"name":"world"}';
      },
    });
    const session = new AgentSession({ model: 'sonnet', provider, apiKey: 'test-key' });
    try {
      await session.sendMessageStructured('classify this', NAME_SCHEMA);
      expect(prompts[0]!).toContain('JSON Schema');
      expect(prompts[0]!).toContain('"name"'); // schema field name reaches the model
    } finally {
      await session.close();
    }
  });

  it('sends content verbatim when injectSchemaPrompt is false', async () => {
    const prompts: string[] = [];
    const provider = createMockProvider({
      respond: (turn) => {
        prompts.push(typeof turn.content === 'string' ? turn.content : '');
        return '{"name":"world"}';
      },
    });
    const session = new AgentSession({ model: 'sonnet', provider, apiKey: 'test-key' });
    try {
      await session.sendMessageStructured('{"name":"world"}', NAME_SCHEMA, { injectSchemaPrompt: false });
      expect(prompts[0]!).toBe('{"name":"world"}');
    } finally {
      await session.close();
    }
  });
});

describe('queryStructured()', () => {
  it('resolves to the parsed object and closes the session', async () => {
    const provider = createMockProvider({ respond: () => '{"v":42}' });
    const out = await queryStructured(
      '{"v":42}',
      z.object({ v: z.number() }),
      { provider, apiKey: 'test-key' },
    );
    expect(out).toEqual({ v: 42 });
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('forwards maxRetries and closes the session even when it throws', async () => {
    const provider = createMockProvider({ respond: () => 'no json' });
    await expect(
      queryStructured('x', NAME_SCHEMA, { provider, apiKey: 'test-key', maxRetries: 0 }),
    ).rejects.toThrow(/did not match schema after 1 attempt/);
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });
});
