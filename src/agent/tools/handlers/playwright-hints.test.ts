import { describe, it, expect } from 'vitest';
import {
  PLAYWRIGHT_MISSING_HINTS,
  browserTimeoutFailureClass,
  isPlaywrightMissing,
  playwrightMissingHint,
} from './playwright-hints.js';

describe('isPlaywrightMissing', () => {
  it('matches the package-not-installed signatures', () => {
    expect(isPlaywrightMissing('Cannot find package playwright')).toBe(true);
    expect(isPlaywrightMissing('Error [ERR_MODULE_NOT_FOUND]: ...')).toBe(true);
  });

  it("matches the chromium-binary-missing signature", () => {
    expect(
      isPlaywrightMissing("browserType.launch: Executable doesn't exist at /path/chrome"),
    ).toBe(true);
  });

  it('does not match unrelated provider errors', () => {
    expect(isPlaywrightMissing('provider init failed')).toBe(false);
    expect(isPlaywrightMissing('net::ERR_NAME_NOT_RESOLVED')).toBe(false);
  });

  it('exposes all three hint substrings', () => {
    expect(PLAYWRIGHT_MISSING_HINTS).toContain('Cannot find package');
    expect(PLAYWRIGHT_MISSING_HINTS).toContain('ERR_MODULE_NOT_FOUND');
    expect(PLAYWRIGHT_MISSING_HINTS).toContain("Executable doesn't exist");
  });
});

describe('playwrightMissingHint', () => {
  it('tells the user to install the package when it is absent', () => {
    const hint = playwrightMissingHint('Cannot find package playwright');
    expect(hint).toMatch(/pnpm add playwright/);
  });

  it('tells the user to install chromium when only the binary is missing', () => {
    const hint = playwrightMissingHint("Executable doesn't exist at /ms-playwright/chromium/chrome");
    expect(hint).toMatch(/pnpm exec playwright install chromium/);
    // Must NOT mis-direct the user to reinstall a package that is already present.
    expect(hint).not.toMatch(/pnpm add playwright/);
  });
});

describe('browserTimeoutFailureClass', () => {
  it("classifies a Playwright TimeoutError (by name) as 'timeout'", () => {
    const err = new Error('page.goto: Timeout 30000ms exceeded.');
    err.name = 'TimeoutError';
    expect(browserTimeoutFailureClass(err)).toBe('timeout');
  });

  it("classifies the timeout message shape as 'timeout' even without the name", () => {
    expect(browserTimeoutFailureClass(new Error('Timeout 30000ms exceeded.'))).toBe('timeout');
    expect(browserTimeoutFailureClass(new Error('locator.click: Timeout 5000 ms exceeded'))).toBe(
      'timeout',
    );
  });

  it('returns undefined for non-timeout errors (left unclassified → still a real failure)', () => {
    expect(browserTimeoutFailureClass(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBeUndefined();
    expect(browserTimeoutFailureClass(new Error('boom'))).toBeUndefined();
    expect(browserTimeoutFailureClass('a plain string')).toBeUndefined();
    expect(browserTimeoutFailureClass(undefined)).toBeUndefined();
  });
});
