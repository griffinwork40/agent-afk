/**
 * Tests for Telegram error classification — specifically the
 * `isTelegramTransportError` guard that prevents a Telegram-origin 429 from
 * being misreported to the user as a *Claude* rate limit.
 */

import { describe, it, expect } from 'vitest';
import { TelegramError } from 'telegraf';
import { isTelegramTransportError, isRateLimitError as tgIsRateLimitError, formatRateLimitReply } from './error-utils.js';
import { UsageLimitError } from '../utils/errors.js';
import { isRateLimitError, isNetworkError } from '../utils/error-classifiers.js';

function makeTelegram429(): TelegramError {
  // Shape telegraf builds on a flood-control response:
  // message === "429: Too Many Requests: retry after N"
  return new TelegramError({
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 5',
    parameters: { retry_after: 5 },
  });
}

describe('isTelegramTransportError', () => {
  it('is true for a telegraf TelegramError (e.g. a flood-control 429)', () => {
    expect(isTelegramTransportError(makeTelegram429())).toBe(true);
  });

  it('is true for non-429 TelegramErrors (400 / 403)', () => {
    expect(
      isTelegramTransportError(
        new TelegramError({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }),
      ),
    ).toBe(true);
    expect(
      isTelegramTransportError(
        new TelegramError({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
      ),
    ).toBe(true);
  });

  it('is false for a real (Claude/provider) rate-limit Error and for non-Errors', () => {
    expect(isTelegramTransportError(new Error('rate limit exceeded'))).toBe(false);
    expect(isTelegramTransportError('429 too many requests')).toBe(false);
    expect(isTelegramTransportError(undefined)).toBe(false);
  });

  it('REGRESSION: a Telegram 429 also matches isRateLimitError — which is exactly why the Telegram guard must be checked FIRST', () => {
    const tgErr = makeTelegram429();
    // The surface-agnostic classifier cannot tell a Telegram 429 from a Claude
    // one (it matches the "too many requests" substring)…
    expect(isRateLimitError(tgErr)).toBe(true);
    expect(isNetworkError(tgErr)).toBe(false);
    // …so the handler must branch on isTelegramTransportError BEFORE
    // isRateLimitError to avoid telling the user "Claude rate limit reached".
    expect(isTelegramTransportError(tgErr)).toBe(true);
  });
});

describe('Telegram usage-limit replies', () => {
  const rawCodex = Object.assign(new Error('429 {"type":"usage_limit_reached"}'), {
    status: 429,
    error: { type: 'usage_limit_reached', plan_type: 'pro', resets_in_seconds: 3600 },
  });

  it('a raw ChatGPT usage limit takes the rate-limit branch with Codex copy', () => {
    expect(tgIsRateLimitError(rawCodex)).toBe(true);
    const reply = formatRateLimitReply(rawCodex);
    expect(reply).toContain('Codex usage limit reached (pro plan), resets at');
    expect(reply).not.toContain('Claude');
  });

  it('a UsageLimitError renders its provider sentence', () => {
    const err = new UsageLimitError('x', { provider: 'anthropic', kind: 'subscription' });
    expect(tgIsRateLimitError(err)).toBe(true);
    expect(formatRateLimitReply(err)).toContain('Claude usage limit reached');
  });

  it('an ordinary rate limit keeps the generic copy', () => {
    const err = new Error('rate limit exceeded');
    expect(tgIsRateLimitError(err)).toBe(true);
    expect(formatRateLimitReply(err)).toBe('⏳ Rate limit reached. Please wait a moment and try again.');
  });

  it('unrelated errors are not rate limits', () => {
    expect(tgIsRateLimitError(new Error('boom'))).toBe(false);
  });
});
