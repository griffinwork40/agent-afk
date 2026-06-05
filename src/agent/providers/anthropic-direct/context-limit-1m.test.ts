/**
 * Regression tests: 1M-context aliases (`opus_1m`, `sonnet_1m`) must report
 * their true context window through `getContextUsage()`.
 *
 * Bug: `opus_1m` resolves to the same wire id as `opus` (`claude-opus-4-8`).
 * The provider stored only the wire id and looked the limit up against it, so
 * `contextLimitFor('claude-opus-4-8')` fell back to the 200k default — the
 * `/tokens` view showed "of 200k" and auto-compaction fired at ~180k instead
 * of ~900k. The fix threads the requested alias through `requestedModel`.
 */

import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderUserTurn } from '../../provider.js';
import { AnthropicDirectQuery } from './query.js';
import type { AnthropicDirectQueryOptions } from './query.js';
import type { ToolDispatcher } from './tool-dispatcher.js';

const noopDispatcher: ToolDispatcher = {
  get toolDefs() {
    return [];
  },
  async execute() {
    return { content: '', isError: false };
  },
};

// getContextUsage() never touches the client or the prompt stream — it reads
// requestedModel + lastUsage only — so an empty stream and a stub client are
// sufficient to exercise the limit lookup in isolation.
async function* emptyStream(): AsyncIterable<ProviderUserTurn> {
  // no turns
}

function makeQuery(overrides: Partial<AnthropicDirectQueryOptions>): AnthropicDirectQuery {
  return new AnthropicDirectQuery({
    client: { messages: { create: vi.fn() } } as unknown as Anthropic,
    authMode: 'api-key',
    promptStream: emptyStream(),
    toolDispatcher: noopDispatcher,
    model: 'claude-opus-4-8',
    maxTokens: 4096,
    tools: null,
    userSystem: null,
    systemPrefix: null,
    ...overrides,
  });
}

describe('getContextUsage — 1M-context aliases', () => {
  it('reports the 1M window for the opus_1m alias (wire id is ambiguous)', async () => {
    const query = makeQuery({ model: 'claude-opus-4-8', requestedModel: 'opus_1m' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(1_000_000);
  });

  it('reports the 1M window for the sonnet_1m alias', async () => {
    const query = makeQuery({ model: 'claude-sonnet-4-6', requestedModel: 'sonnet_1m' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(1_000_000);
  });

  it('reports the 200k base window for opus (same wire id, no 1M alias)', async () => {
    const query = makeQuery({ model: 'claude-opus-4-8', requestedModel: 'opus' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(200_000);
  });

  it('falls back to the wire-id window when no requestedModel is supplied', async () => {
    // Bare full id is ambiguous between an alias and its 1M variant, so the
    // conservative 200k base is the correct default.
    const query = makeQuery({ model: 'claude-opus-4-8' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(200_000);
  });

  it('setModel preserves the alias: switching to sonnet_1m widens the window', async () => {
    const query = makeQuery({ model: 'claude-sonnet-4-6', requestedModel: 'sonnet' });
    expect((await query.getContextUsage()).maxTokens).toBe(200_000);

    await query.setModel('sonnet_1m');
    expect((await query.getContextUsage()).maxTokens).toBe(1_000_000);
  });

  it('setModel resolves the wire id internally for a 1M alias', async () => {
    const query = makeQuery({ model: 'claude-opus-4-8', requestedModel: 'opus' });
    await query.setModel('opus_1m');
    // The wire model surfaced to the Messages API must be the resolved id,
    // never the alias (which would 404).
    const info = await firstSessionInfo(query);
    expect(info.model).toBe('claude-opus-4-8');
    expect((await query.getContextUsage()).maxTokens).toBe(1_000_000);
  });
});

/** Pull the first `session.init` event to read the wire model the loop emits. */
async function firstSessionInfo(
  query: AnthropicDirectQuery,
): Promise<{ model: string }> {
  for await (const ev of query) {
    if (ev.type === 'session.init') {
      // Stop iterating once we have what we need.
      return { model: ev.info.model };
    }
  }
  throw new Error('no session.init event emitted');
}
