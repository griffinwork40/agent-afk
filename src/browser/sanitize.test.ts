/**
 * Tests for src/browser/sanitize.ts
 *
 * Covers each secret pattern (positive + negative), shouldRedactElementValue,
 * hashSelector determinism/format, truncateTargetText collapsing/truncation,
 * and summarizeObservation length/content guarantees.
 */

import { describe, expect, it } from 'vitest';
import {
  hashSelector,
  shouldRedactElementValue,
  summarizeObservation,
  truncateTargetText,
} from './sanitize.js';

// ---------------------------------------------------------------------------
// shouldRedactElementValue
// ---------------------------------------------------------------------------

describe('shouldRedactElementValue', () => {
  it('returns true for a textbox with kind=password', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'password', label: '' })
    ).toBe(true);
  });

  it('returns false for a textbox with kind=text', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: '' })
    ).toBe(false);
  });

  it('returns false for a button with kind=password (role mismatch)', () => {
    expect(
      shouldRedactElementValue({ role: 'button', kind: 'password', label: '' })
    ).toBe(false);
  });

  it('returns true when label contains "password"', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: 'Enter password' })
    ).toBe(true);
  });

  it('returns true when label contains "secret"', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: 'Your secret key' })
    ).toBe(true);
  });

  it('returns true when label contains "token"', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: 'API Token' })
    ).toBe(true);
  });

  it('returns true when label contains "api_key"', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: 'api_key' })
    ).toBe(true);
  });

  it('returns true when label contains "api-key"', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: 'api-key' })
    ).toBe(true);
  });

  it('returns true when label contains "otp"', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: 'Enter OTP' })
    ).toBe(true);
  });

  it('returns true when label contains "2fa"', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: '2FA code' })
    ).toBe(true);
  });

  it('returns false for a non-sensitive element', () => {
    expect(
      shouldRedactElementValue({ role: 'textbox', kind: 'text', label: 'Username' })
    ).toBe(false);
  });

  it('returns false when role and kind are both undefined and label is absent', () => {
    expect(shouldRedactElementValue({})).toBe(false);
  });

  it('returns false when label is undefined (no kind match)', () => {
    expect(shouldRedactElementValue({ role: 'textbox', kind: 'text' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hashSelector
// ---------------------------------------------------------------------------

describe('hashSelector', () => {
  it('returns exactly 8 characters', () => {
    const result = hashSelector('[data-testid="submit-button"]');
    expect(result).toHaveLength(8);
  });

  it('returns lowercase hex characters only', () => {
    const result = hashSelector('#my-input');
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic — same input always returns same hash', () => {
    const selector = 'button.primary[type="submit"]';
    expect(hashSelector(selector)).toBe(hashSelector(selector));
  });

  it('produces different hashes for different selectors', () => {
    expect(hashSelector('#foo')).not.toBe(hashSelector('#bar'));
  });

  it('handles an empty string without throwing', () => {
    const result = hashSelector('');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// truncateTargetText
// ---------------------------------------------------------------------------

describe('truncateTargetText', () => {
  it('collapses multi-line input to a single line', () => {
    const input = 'Submit\nthe\nform';
    expect(truncateTargetText(input)).toBe('Submit the form');
  });

  it('collapses runs of mixed whitespace', () => {
    const input = 'Click\t\n  here   now';
    expect(truncateTargetText(input)).toBe('Click here now');
  });

  it('trims leading and trailing whitespace', () => {
    const input = '  hello world  ';
    expect(truncateTargetText(input)).toBe('hello world');
  });

  it('returns strings ≤80 chars unchanged', () => {
    const input = 'A'.repeat(80);
    expect(truncateTargetText(input)).toBe(input);
  });

  it('truncates a 100-char string to 80 chars with ellipsis', () => {
    const input = 'A'.repeat(100);
    const result = truncateTargetText(input);
    expect(result).toHaveLength(80);
    expect(result.slice(-3)).toBe('...');
    expect(result.slice(0, 77)).toBe('A'.repeat(77));
  });

  it('truncates a multi-line string that expands beyond 80 chars after collapse', () => {
    // 85 'x' chars split across lines — collapses to 85 chars, needs truncation.
    const input = 'x'.repeat(40) + '\n' + 'x'.repeat(45);
    const result = truncateTargetText(input);
    // After collapsing: 85 chars + 1 space char in the middle = 86 chars → truncated.
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.slice(-3)).toBe('...');
  });

  it('handles an empty string', () => {
    expect(truncateTargetText('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// summarizeObservation
// ---------------------------------------------------------------------------

describe('summarizeObservation', () => {
  const baseObs = {
    url: 'https://example.com/login',
    title: 'Login – Example',
    interactive: [
      { label: 'Username', role: 'textbox' },
      { label: 'Password', role: 'textbox' },
      { label: 'Sign in', role: 'button' },
      { label: 'Forgot password?', role: 'link' },
    ],
    status: { httpStatus: 200, loadingState: 'idle' as const },
  };

  it('produces a string ≤500 chars', () => {
    expect(summarizeObservation(baseObs).length).toBeLessThanOrEqual(500);
  });

  it('includes the HTTP status code', () => {
    expect(summarizeObservation(baseObs)).toContain('200');
  });

  it('includes the URL', () => {
    expect(summarizeObservation(baseObs)).toContain('https://example.com/login');
  });

  it('includes the title', () => {
    expect(summarizeObservation(baseObs)).toContain('Login – Example');
  });

  it('includes up to 3 interactive element labels', () => {
    const result = summarizeObservation(baseObs);
    expect(result).toContain('textbox:Username');
    expect(result).toContain('textbox:Password');
    expect(result).toContain('button:Sign in');
    // The 4th element should NOT appear.
    expect(result).not.toContain('Forgot password?');
  });

  it('renders "--" when httpStatus is null', () => {
    const obs = {
      ...baseObs,
      status: { httpStatus: null, loadingState: 'idle' as const },
    };
    expect(summarizeObservation(obs)).toMatch(/^-- /);
  });

  it('handles an empty interactive array gracefully', () => {
    const obs = { ...baseObs, interactive: [] };
    const result = summarizeObservation(obs);
    expect(result).toContain('[]');
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('trims to exactly 500 chars when summary is very long', () => {
    const obs = {
      url: 'https://example.com/' + 'a'.repeat(300),
      title: 'b'.repeat(200),
      interactive: [
        { label: 'c'.repeat(100), role: 'textbox' },
      ],
      status: { httpStatus: 200, loadingState: 'idle' as const },
    };
    const result = summarizeObservation(obs);
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
