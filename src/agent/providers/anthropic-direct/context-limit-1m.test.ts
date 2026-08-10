/**
 * Regression tests: 1M-context aliases (`opus_1m`, `sonnet_1m`) and the base
 * `opus`/`sonnet` handles must report their true context window through
 * `getContextUsage()`.
 *
 * History: `opus_1m` resolves to the same wire id as `opus`. Back when base
 * `opus` was claude-opus-4-8 (200k), the provider stored only the wire id and
 * looked the limit up against it, so the 1M variant fell back to the 200k
 * default — the `/tokens` view showed "of 200k" and auto-compaction fired
 * early. The fix threads the requested alias through `requestedModel`. Opus 5
 * (GA 2026-07-24) is natively 1M, so base `opus` now also reports 1M; the
 * early-compaction distinction moved to autoCompactLimitFor's working budget.
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
    model: 'claude-opus-5',
    maxTokens: 4096,
    tools: null,
    userSystem: null,
    systemPrefix: null,
    ...overrides,
  });
}

describe('getContextUsage — 1M-context aliases', () => {
  it('reports the 1M window for the opus_1m alias (wire id is ambiguous)', async () => {
    const query = makeQuery({ model: 'claude-opus-5', requestedModel: 'opus_1m' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(1_000_000);
  });

  it('reports the 1M window for the sonnet_1m alias', async () => {
    const query = makeQuery({ model: 'claude-sonnet-5', requestedModel: 'sonnet_1m' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(1_000_000);
  });

  it('reports the true 1M window for base opus (Opus 5 is natively 1M)', async () => {
    // getContextUsage reports the model's real window. Base `opus` compacts
    // early via a working budget (see autoCompactLimitFor), but the status-line
    // window it reports here is the full 1M — same profile as base `sonnet`.
    const query = makeQuery({ model: 'claude-opus-5', requestedModel: 'opus' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(1_000_000);
  });

  it('falls back to the 200k Anthropic default for an unknown/retired wire id', async () => {
    // A bare wire id that is in no limits table and carries no requestedModel
    // hint falls back to the conservative 200k Anthropic default.
    //
    // Invariant: this case previously used `claude-opus-4-8` as its example of a
    // "retired" id. That was wrong twice over — 4.8 is Active per Anthropic's
    // deprecation table AND it is a 1M-window model, so it now has explicit
    // entries and no longer exercises the fallback at all. The example is now
    // claude-opus-4-1-20250805, which Anthropic genuinely retired on 2026-08-05.
    // <https://platform.claude.com/docs/en/about-claude/model-deprecations>
    const query = makeQuery({ model: 'claude-opus-4-1-20250805' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(200_000);
  });

  it('reports the true 1M window for base sonnet (Sonnet 5 is natively 1M)', async () => {
    // getContextUsage reports the model's real window. Base `sonnet` compacts
    // early via a working budget (see autoCompactLimitFor), but the status-line
    // window it reports here is the full 1M.
    const query = makeQuery({ model: 'claude-sonnet-5', requestedModel: 'sonnet' });
    const usage = await query.getContextUsage();
    expect(usage.maxTokens).toBe(1_000_000);
  });

  it('setModel preserves the alias: opus and opus_1m both report 1M on Opus 5', async () => {
    // Opus 5 is natively 1M, so both the base `opus` alias and `opus_1m` report
    // the full 1M window here. (The early-compaction distinction now lives in
    // autoCompactLimitFor's working budget, not the reported window.)
    const query = makeQuery({ model: 'claude-opus-5', requestedModel: 'opus' });
    expect((await query.getContextUsage()).maxTokens).toBe(1_000_000);

    await query.setModel('opus_1m');
    expect((await query.getContextUsage()).maxTokens).toBe(1_000_000);
  });

  it('setModel resolves the wire id internally for a 1M alias', async () => {
    const query = makeQuery({ model: 'claude-opus-5', requestedModel: 'opus' });
    await query.setModel('opus_1m');
    // The wire model surfaced to the Messages API must be the resolved id,
    // never the alias (which would 404).
    const info = await firstSessionInfo(query);
    expect(info.model).toBe('claude-opus-5');
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
