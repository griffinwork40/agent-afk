/**
 * Tests for Telegram error classification — specifically the
 * `isTelegramTransportError` guard that prevents a Telegram-origin 429 from
 * being misreported to the user as a *Claude* rate limit.
 */

import { describe, it, expect } from 'vitest';
import { TelegramError } from 'telegraf';
import { isTelegramTransportError } from './error-utils.js';
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
