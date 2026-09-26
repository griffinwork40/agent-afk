import { describe, it, expect } from 'vitest';
import { FastModeController } from '../../../fast-mode.js';
import { CHATGPT_BACKEND_BASE_URL } from '../responses-config.js';
import { FastTierSession, isCustomOpenAIEndpoint } from './fast-tier-session.js';

const session = (pref: 'on' | 'off' = 'on') =>
  new FastTierSession({ controller: new FastModeController(pref), hasCustomEndpoint: false });

describe('isCustomOpenAIEndpoint', () => {
  it('treats unset and the ChatGPT backend as first-party', () => {
    expect(isCustomOpenAIEndpoint(undefined)).toBe(false);
    expect(isCustomOpenAIEndpoint(CHATGPT_BACKEND_BASE_URL)).toBe(false);
  });
  it('treats a user-set base URL as custom', () => {
    expect(isCustomOpenAIEndpoint('http://localhost:8080/v1')).toBe(true);
  });
});

describe('FastTierSession', () => {
  it('is inert without options', async () => {
    const s = new FastTierSession(undefined);
    expect(s.beginTurn('gpt-5.5')).toBe(false);
    const seen: Array<Record<string, unknown>> = [];
    await s.create({ a: 1 }, async (b) => { seen.push(b); });
    expect(seen[0]).toEqual({ a: 1 });
  });

  it('adds service_tier without mutating the caller body', async () => {
    const s = session();
    expect(s.beginTurn('gpt-5.5')).toBe(true);
    const body = { a: 1 };
    const seen: Array<Record<string, unknown>> = [];
    await s.create(body, async (b) => { seen.push(b); });
    expect(seen[0]).toEqual({ a: 1, service_tier: 'priority' });
    expect(body).toEqual({ a: 1 });
  });

  it('confirms fast only when the response echoes priority or fast', () => {
    const s = session();
    s.beginTurn('gpt-5.5');
    expect(s.confirmedFast()).toBe(false);
    s.observeResponsesEvent({ type: 'response.completed', response: { service_tier: 'priority' } });
    expect(s.confirmedFast()).toBe(true);
    s.beginTurn('gpt-5.5'); // reset per turn
    expect(s.confirmedFast()).toBe(false);
    s.observeChatChunk({ service_tier: 'fast' });
    expect(s.confirmedFast()).toBe(true);
  });

  it('ignores tiers observed on a non-fast turn', () => {
    const s = session('off');
    s.beginTurn('gpt-5.5');
    s.observeChatChunk({ service_tier: 'default' });
    expect([...s.drainNotice('x')]).toHaveLength(0);
  });

  it('queues the downgrade notice once per session', () => {
    const s = session();
    s.beginTurn('gpt-5.5');
    s.observeChatChunk({ service_tier: 'default' });
    const first = [...s.drainNotice('sess')];
    expect(first).toEqual([expect.objectContaining({ type: 'notice', kind: 'fast-tier', sessionId: 'sess' })]);
    s.beginTurn('gpt-5.5');
    s.observeChatChunk({ service_tier: 'default' });
    expect([...s.drainNotice('sess')]).toHaveLength(0);
  });

  it('latches off after a service_tier rejection and retries once without it', async () => {
    const s = session();
    s.beginTurn('gpt-5.5');
    const seen: Array<Record<string, unknown>> = [];
    const result = await s.create({ a: 1 }, async (b) => {
      seen.push(b);
      if (seen.length === 1) throw Object.assign(new Error('Unsupported value: service_tier'), { status: 400 });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen[1]).toEqual({ a: 1 });
    expect(s.active).toBe(false);
    expect(s.beginTurn('gpt-5.5')).toBe(false);
  });

  it('rethrows unrelated errors without retrying', async () => {
    const s = session();
    s.beginTurn('gpt-5.5');
    let n = 0;
    await expect(s.create({}, async () => { n++; throw Object.assign(new Error('rate limited'), { status: 429 }); }))
      .rejects.toThrow('rate limited');
    expect(n).toBe(1);
    expect(s.active).toBe(true);
  });
});
