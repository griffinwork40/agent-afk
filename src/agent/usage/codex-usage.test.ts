import { describe, it, expect, vi } from 'vitest';
import { fetchCodexUsage, parseCodexUsagePayload } from './codex-usage.js';

const SIGNED_IN = () => ({ apiKey: 'tok-secret', source: 'chatgpt-oauth' as const, accountId: 'acct-1' });
const RESET_S = 1_791_580_263;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('parseCodexUsagePayload', () => {
  it('classifies windows by length, not position (weekly primary)', () => {
    const r = parseCodexUsagePayload({
      rate_limit: { primary_window: { used_percent: 47, limit_window_seconds: 604_800, reset_at: RESET_S }, secondary_window: null },
    });
    expect(r).toEqual({ kind: 'ok', sevenDay: { utilization: 0.47, resetsAt: new Date(RESET_S * 1000) } });
  });

  it('maps a 5h primary and a 7d secondary', () => {
    const r = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: RESET_S },
        secondary_window: { used_percent: 10, limit_window_seconds: 604_800 },
      },
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.fiveHour?.utilization).toBe(0.25);
    expect(r.sevenDay).toEqual({ utilization: 0.1 });
  });

  it('drops windows of an unrecognised length instead of mislabelling them', () => {
    const r = parseCodexUsagePayload({
      rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 7_200 } },
    });
    expect(r.kind).toBe('unavailable');
  });

  it('clamps out-of-range percentages and ignores absurd reset times', () => {
    const r = parseCodexUsagePayload({
      rate_limit: { primary_window: { used_percent: 140, limit_window_seconds: 18_000, reset_at: 9e12 } },
    });
    expect(r).toEqual({ kind: 'ok', fiveHour: { utilization: 1 } });
  });

  it('treats a missing rate_limit as malformed', () => {
    expect(parseCodexUsagePayload({}).kind).toBe('unavailable');
  });
});

describe('fetchCodexUsage', () => {
  it('sends the ChatGPT sign-in with AFK request headers and maps the body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ rate_limit: { primary_window: { used_percent: 47, limit_window_seconds: 604_800, reset_at: RESET_S } } }),
    );
    const r = await fetchCodexUsage({ auth: SIGNED_IN, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.kind).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-secret');
    expect(headers['chatgpt-account-id']).toBe('acct-1');
    expect(headers['originator']).toBe('agent-afk');
  });

  it('reports no-token without a network call when not signed in or expired', async () => {
    const fetchImpl = vi.fn();
    const none = await fetchCodexUsage({ auth: () => ({ apiKey: null, source: 'no-usable-auth' }), fetchImpl: fetchImpl as unknown as typeof fetch });
    const expired = await fetchCodexUsage({ auth: () => ({ apiKey: null, source: 'chatgpt-oauth-expired' }), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(none).toMatchObject({ kind: 'unavailable', reason: 'no-token' });
    expect(expired).toMatchObject({ kind: 'unavailable', reason: 'no-token' });
    expect(expired.kind === 'unavailable' && expired.detail).toMatch(/expired/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never leaks the response body or token on an HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret page tok-secret', { status: 401 }));
    const r = await fetchCodexUsage({ auth: SIGNED_IN, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ kind: 'unavailable', reason: 'http-error', detail: 'Usage endpoint returned HTTP 401.' });
  });

  it('contains a throwing auth resolver', async () => {
    const r = await fetchCodexUsage({ auth: () => { throw new Error('bad auth.json'); } });
    expect(r).toMatchObject({ kind: 'unavailable', reason: 'no-token' });
  });
});
