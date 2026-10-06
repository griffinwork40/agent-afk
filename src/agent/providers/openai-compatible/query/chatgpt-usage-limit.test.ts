import { describe, it, expect } from 'vitest';
import { classifyChatGptUsageLimit, isChatGptUsageLimitError } from './chatgpt-usage-limit.js';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const NOW_SEC = Math.floor(NOW / 1000);

/** Shape the openai SDK produces for a status-bearing 429: body on `.error`, `type` copied up. */
function sdk429(body: Record<string, unknown>, headers?: Record<string, string>): Error {
  const e = new Error(`429 ${String(body['message'] ?? '')}`) as Error & Record<string, unknown>;
  e['status'] = 429;
  e['error'] = body;
  e['type'] = body['type'];
  if (headers) e['headers'] = new Headers(headers);
  return e;
}

const limitBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'usage_limit_reached',
  message: 'The usage limit has been reached',
  plan_type: 'plus',
  resets_at: NOW_SEC + 13_872,
  resets_in_seconds: 13_872,
  ...over,
});

describe('classifyChatGptUsageLimit', () => {
  it('flat SDK shape: reads resets_at and plan', () => {
    const info = classifyChatGptUsageLimit(sdk429(limitBody()), NOW);
    expect(info).not.toBeNull();
    expect(info!.resetsAt?.getTime()).toBe((NOW_SEC + 13_872) * 1000);
    expect(info!.plan).toBe('plus');
  });

  it('nested .error.error shape (raw JSON response body on .error)', () => {
    const e = Object.assign(new Error('429'), { status: 429, error: { error: limitBody() } });
    const info = classifyChatGptUsageLimit(e, NOW);
    expect(info?.plan).toBe('plus');
    expect(info?.resetsAt).toBeInstanceOf(Date);
  });

  it('top-level type only (plain object, no body)', () => {
    expect(classifyChatGptUsageLimit({ type: 'usage_limit_reached' }, NOW)).toEqual({});
  });

  it('status-less mid-stream error is still matched', () => {
    const e = Object.assign(new Error('The usage limit has been reached'), {
      status: undefined,
      error: limitBody(),
      type: 'usage_limit_reached',
    });
    expect(classifyChatGptUsageLimit(e, NOW)?.plan).toBe('plus');
    expect(isChatGptUsageLimitError(e)).toBe(true);
  });

  it('prefers resets_at over resets_in_seconds', () => {
    const info = classifyChatGptUsageLimit(sdk429(limitBody({ resets_at: NOW_SEC + 600, resets_in_seconds: 9_999 })), NOW);
    expect(info?.resetsAt?.getTime()).toBe((NOW_SEC + 600) * 1000);
  });

  it('falls back to resets_in_seconds when resets_at is absent', () => {
    const info = classifyChatGptUsageLimit(sdk429(limitBody({ resets_at: undefined, resets_in_seconds: 120 })), NOW);
    expect(info?.resetsAt?.getTime()).toBe(NOW + 120_000);
  });

  it.each([
    ['NaN string', 'not-a-number'],
    ['negative', -5],
    ['zero', 0],
    ['beyond Date range', 9e15],
    ['far in the past', NOW_SEC - 10 * 86_400],
    ['years ahead', NOW_SEC + 5 * 365 * 86_400],
  ])('bad resets_at (%s) falls back to resets_in_seconds', (_label, bad) => {
    const info = classifyChatGptUsageLimit(sdk429(limitBody({ resets_at: bad, resets_in_seconds: 60 })), NOW);
    expect(info?.resetsAt?.getTime()).toBe(NOW + 60_000);
  });

  it('bad resets_at and bad resets_in_seconds yields no reset but still classifies', () => {
    const info = classifyChatGptUsageLimit(sdk429(limitBody({ resets_at: 'x', resets_in_seconds: -1 })), NOW);
    expect(info).not.toBeNull();
    expect(info?.resetsAt).toBeUndefined();
  });

  it('drops an unprintable plan label', () => {
    const info = classifyChatGptUsageLimit(sdk429(limitBody({ plan_type: '<script>\n' })), NOW);
    expect(info?.plan).toBeUndefined();
  });

  it('reads windowMinutes from x-codex-primary-window-minutes header', () => {
    const e = sdk429(limitBody(), { 'x-codex-primary-window-minutes': '300' });
    expect(classifyChatGptUsageLimit(e, NOW)?.windowMinutes).toBe(300);
  });

  it('hostile x-codex-active-limit value cannot select an arbitrary header', () => {
    // A server sets x-codex-active-limit to "evil" and x-evil-primary-window-minutes to "999".
    // The header name is hardcoded so this hostile attempt has no effect.
    const e = sdk429(limitBody(), {
      'x-codex-active-limit': 'evil',
      'x-evil-primary-window-minutes': '999',
      'x-codex-primary-window-minutes': '300',
    });
    // Only the hardcoded header is read; the injected value is ignored.
    expect(classifyChatGptUsageLimit(e, NOW)?.windowMinutes).toBe(300);
  });

  it('no x-codex-primary-window-minutes header yields no windowMinutes', () => {
    const e = sdk429(limitBody(), { 'x-codex-active-limit': 'codex' });
    expect(classifyChatGptUsageLimit(e, NOW)?.windowMinutes).toBeUndefined();
  });

  it('a plain 429 returns null', () => {
    const e = Object.assign(new Error('429 Rate limit reached'), {
      status: 429,
      error: { type: 'rate_limit_exceeded', message: 'Rate limit reached' },
      headers: new Headers({ 'retry-after': '20' }),
    });
    expect(classifyChatGptUsageLimit(e, NOW)).toBeNull();
    expect(isChatGptUsageLimitError(e)).toBe(false);
  });

  it('non-objects return null', () => {
    expect(classifyChatGptUsageLimit(undefined)).toBeNull();
    expect(classifyChatGptUsageLimit('usage_limit_reached')).toBeNull();
    expect(classifyChatGptUsageLimit(null)).toBeNull();
  });
});
