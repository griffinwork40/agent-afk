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
  redactSecrets,
  shouldRedactElementValue,
  summarizeObservation,
  truncateTargetText,
} from './sanitize.js';

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

describe('redactSecrets', () => {
  describe('AWS Access Key (AKIA…)', () => {
    it('redacts a well-formed AWS access key', () => {
      const input = 'key=AKIAIOSFODNN7EXAMPLE';
      expect(redactSecrets(input)).toBe('key=[redacted]');
    });

    it('leaves a short AKIA-prefixed string that is too short alone', () => {
      // Only 10 chars after AKIA — not 16, so no match.
      const input = 'AKIA1234567890';
      expect(redactSecrets(input)).toBe('AKIA1234567890');
    });

    it('leaves plain text without AKIA unchanged', () => {
      expect(redactSecrets('hello world')).toBe('hello world');
    });
  });

  describe('Generic bearer token (sk-…)', () => {
    it('redacts an OpenAI-style sk- token', () => {
      const input = 'Authorization: Bearer sk-abcdefghijklmnopqrstu';
      expect(redactSecrets(input)).toContain('[redacted]');
      expect(redactSecrets(input)).not.toContain('sk-abcdefghijklmnopqrstu');
    });

    it('leaves a short sk- fragment alone (fewer than 20 trailing chars)', () => {
      // 'sk-short' has only 5 trailing chars — below the 20-char minimum.
      const input = 'sk-short';
      expect(redactSecrets(input)).toBe('sk-short');
    });
  });

  describe('GitHub PAT (ghp_…)', () => {
    it('redacts a valid GitHub PAT', () => {
      // Exactly 36 alphanum chars after ghp_
      const token = 'ghp_' + 'A'.repeat(36);
      expect(redactSecrets(token)).toBe('[redacted]');
    });

    it('leaves a truncated ghp_ token alone (35 chars)', () => {
      const token = 'ghp_' + 'A'.repeat(35);
      expect(redactSecrets(token)).toBe(token);
    });

    it('leaves unrelated text unchanged', () => {
      expect(redactSecrets('some identifier ghp_abc')).toBe(
        'some identifier ghp_abc'
      );
    });
  });

  describe('Slack token (xox[abp]-…)', () => {
    it('redacts a Slack bot token', () => {
      const input = 'token=xoxb-123456789012-abcdefghijk';
      expect(redactSecrets(input)).toBe('token=[redacted]');
    });

    it('redacts a Slack app token', () => {
      const input = 'xoxa-verylongslackapptoken12';
      expect(redactSecrets(input)).toBe('[redacted]');
    });

    it('leaves xox with fewer than 10 trailing chars alone', () => {
      // 'xoxb-123' is only 3 chars after the dash — below the 10-char minimum.
      const input = 'xoxb-123';
      expect(redactSecrets(input)).toBe('xoxb-123');
    });
  });

  describe('Form-encoded password field', () => {
    it('redacts the value but preserves the key name', () => {
      const input = 'username=alice&password=hunter2&remember=true';
      const result = redactSecrets(input);
      expect(result).toContain('password=[redacted]');
      expect(result).not.toContain('hunter2');
      expect(result).toContain('username=alice');
    });

    it('handles password at end of string', () => {
      const input = 'user=bob&password=s3cr3t';
      const result = redactSecrets(input);
      expect(result).toBe('user=bob&password=[redacted]');
    });

    it('leaves fields not named password unchanged', () => {
      const input = 'username=alice&email=alice@example.com';
      expect(redactSecrets(input)).toBe(input);
    });
  });

  describe('JWT', () => {
    it('redacts a valid JWT', () => {
      // Construct a realistic JWT shape (3 base64url segments ≥20 chars each).
      const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0';
      const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const token = `${header}.${payload}.${sig}`;
      const result = redactSecrets(`Bearer ${token}`);
      expect(result).toBe('Bearer [redacted]');
    });

    it('leaves short base64 blobs unchanged (segments < 20 chars)', () => {
      // Each segment is only 10 chars — does not match the ≥20 rule.
      const input = 'eyJhbGci.eyJzdWIi.signature';
      expect(redactSecrets(input)).toBe(input);
    });
  });

  it('returns the original string when nothing matches', () => {
    const input = 'totally normal text with no secrets';
    expect(redactSecrets(input)).toBe(input);
  });
});

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
