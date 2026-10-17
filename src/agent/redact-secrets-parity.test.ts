/**
 * Parity test: every egress helper must redact the same fixture of known
 * secret shapes.  Regression guard for issue #3848.
 *
 * Before the fix:
 *   - `redactSecrets` (canonical) missed: xox tokens, Telegram bot tokens,
 *     sk- (non-ant) keys.
 *   - `redactInlineSecrets` (prompt-dump) missed: JWT, AWS STS/AROA prefixes,
 *     generic ≥32-char blobs — and had its own duplicate patterns instead of
 *     delegating to the canonical redactor.
 *   - `bot.ts` had a one-off `/bot<TOKEN>/` URL replace.
 *
 * After the fix:
 *   - `redactSecrets` covers all explicit shapes.
 *   - `redactInlineSecrets` delegates to `redactSecrets` then adds NAME=value.
 *   - All egress helpers that already called `redactSecrets` inherit the new
 *     shapes automatically.
 *
 * @module agent/redact-secrets-parity.test
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact-secrets.js';
import { redactInlineSecrets } from './session/prompt-dump.js';

/**
 * Fixture of known secret shapes — NEVER use real credentials here.
 * Each entry: [label, plaintext containing a fake secret, the fake secret value].
 */
const SECRET_FIXTURES: Array<[label: string, text: string, secret: string]> = [
  // Anthropic API key
  [
    'sk-ant key',
    'key=sk-ant-api03-FakeKeyForTestingOnly12345678901234567890',
    'sk-ant-api03-FakeKeyForTestingOnly12345678901234567890',
  ],
  // OpenAI / generic sk- key (non-ant)
  [
    'sk- non-ant key',
    'OPENAI_API_KEY=sk-FakeOpenAIKeyForTestingPurposesOnly12345',
    'sk-FakeOpenAIKeyForTestingPurposesOnly12345',
  ],
  // Bearer token (Authorization header)
  [
    'Bearer header token',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.fakepayload.fakesig',
    'eyJhbGciOiJIUzI1NiJ9.fakepayload.fakesig',
  ],
  // JWT (three base64url segments)
  [
    'JWT token',
    'token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.FakeSig1234567890abcdef',
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.FakeSig1234567890abcdef',
  ],
  // AWS long-term access key (AKIA prefix)
  [
    'AWS AKIA key',
    'aws_access_key=AKIAFAKEKEY1234ABCDE',
    'AKIAFAKEKEY1234ABCDE',
  ],
  // AWS STS temporary credential (ASIA prefix)
  [
    'AWS ASIA STS key',
    'aws_sts_key=ASIAFAKEKEY1234ABCDE',
    'ASIAFAKEKEY1234ABCDE',
  ],
  // Slack bot token (obviously fake — segments use TEST/FAKE words, not real numeric ids)
  [
    'Slack xoxb token',
    'slack_token=xoxb-TESTONLYID-TESTONLYID-FakeSlackTestFixtureOnly',
    'xoxb-TESTONLYID-TESTONLYID-FakeSlackTestFixtureOnly',
  ],
  // Slack app token (obviously fake)
  [
    'Slack xoxa token',
    'slack_app=xoxa-FAKETEST00-abcdefghijklmnopqrst',
    'xoxa-FAKETEST00-abcdefghijklmnopqrst',
  ],
  // Telegram bot token (digits:alphanum35)
  [
    'Telegram bot token',
    'bot_token=123456789:FakeTelegramBotTokenForTesting1234',
    '123456789:FakeTelegramBotTokenForTesting1234',
  ],
  // Generic ≥32-char opaque blob
  [
    'generic 32-char opaque token',
    'value=aB3xQ9zK7mN2pL5vR8tY1wC4dF6gH0jM',
    'aB3xQ9zK7mN2pL5vR8tY1wC4dF6gH0jM',
  ],
];

describe('redactSecrets parity — canonical redactor', () => {
  for (const [label, text, secret] of SECRET_FIXTURES) {
    it(`redacts ${label}`, () => {
      const result = redactSecrets(text);
      expect(result, `${label}: secret must be absent`).not.toContain(secret);
      expect(result, `${label}: [REDACTED] marker must be present`).toContain('[REDACTED]');
    });
  }
});

describe('redactInlineSecrets parity — prompt-dump egress', () => {
  for (const [label, text, secret] of SECRET_FIXTURES) {
    it(`redacts ${label}`, () => {
      const result = redactInlineSecrets(text);
      expect(result, `${label}: secret must be absent`).not.toContain(secret);
      // redactInlineSecrets delegates to redactSecrets so emits [REDACTED] for
      // the canonical shapes; NAME=value patterns emit <REDACTED length=N>.
      // Either marker is acceptable — just verify the secret is gone.
    });
  }

  it('also redacts NAME=value env-style secrets (supplement over canonical)', () => {
    const secret = 'supersecretvalueatleast16chars';
    const text = `MY_API_TOKEN=${secret}`;
    const result = redactInlineSecrets(text);
    expect(result).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// False-positive / narrowing tests for items 1–3 (issue #3934)
// ---------------------------------------------------------------------------

describe('false-positive narrowing — bare Bearer rule (issue #3934 item 1)', () => {
  it('does NOT redact "bearer of bad news" (stopword "of")', () => {
    const result = redactSecrets('the bearer of bad news');
    expect(result).toBe('the bearer of bad news');
  });

  it('does NOT redact "invalid bearer token" (stopword "token")', () => {
    const result = redactSecrets('invalid bearer token');
    expect(result).toBe('invalid bearer token');
  });

  it('does NOT redact "bearer to the rescue" (stopword "to")', () => {
    const result = redactSecrets('bearer to the rescue');
    expect(result).toBe('bearer to the rescue');
  });

  it('DOES redact a real short token (8-char floor)', () => {
    const result = redactSecrets('Bearer abcdef0123456789TOKEN');
    expect(result).not.toContain('abcdef0123456789TOKEN');
    expect(result).toContain('[REDACTED]');
  });

  it('DOES redact an exactly 8-char token (floor boundary)', () => {
    const result = redactSecrets('Bearer abcdef01');
    expect(result).not.toContain('abcdef01');
    expect(result).toContain('[REDACTED]');
  });

  it('does NOT redact a 7-char token (below floor)', () => {
    const result = redactSecrets('Bearer abcdef0');
    expect(result).toBe('Bearer abcdef0');
  });

  it('DOES redact a hyphenated stopword-prefixed token (Bearer token-abc12345)', () => {
    const result = redactSecrets('Bearer token-abc12345');
    expect(result).not.toContain('token-abc12345');
    expect(result).toContain('[REDACTED]');
  });

  it('DOES redact a hyphenated stopword-prefixed token (Bearer the-quick-brown-fox)', () => {
    const result = redactSecrets('Bearer the-quick-brown-fox');
    expect(result).not.toContain('the-quick-brown-fox');
    expect(result).toContain('[REDACTED]');
  });

  it('preserves bearer casing in replacement (no Title-case forced)', () => {
    const result = redactSecrets('authorization: bearer abcdef0123456789');
    expect(result).toBe('authorization: bearer [REDACTED]');
  });
});

describe('false-positive narrowing — AWS key-id mid-uppercase-run (issue #3934 item 2)', () => {
  it('does NOT match XAKIA… inside a longer uppercase run', () => {
    const result = redactSecrets('XAKIAFAKEKEY1234ABCDE');
    expect(result).toBe('XAKIAFAKEKEY1234ABCDE');
  });

  it('DOES redact a bare AKIA… key', () => {
    const result = redactSecrets('AKIAFAKEKEY1234ABCDE');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('AKIAFAKEKEY1234ABCDE');
  });

  it('DOES redact keyAKIA… (lowercase before prefix)', () => {
    const result = redactSecrets('keyAKIAFAKEKEY1234ABCDE');
    expect(result).not.toContain('AKIAFAKEKEY1234ABCDE');
    expect(result).toContain('[REDACTED]');
  });
});

describe('label-casing preservation — Authorization header (issue #3934 item 3)', () => {
  it('preserves lowercase "authorization: bearer" label', () => {
    const result = redactSecrets('authorization: bearer abcdef0123456789');
    expect(result).toBe('authorization: bearer [REDACTED]');
  });

  it('preserves Title-case "Authorization: Bearer" label', () => {
    const result = redactSecrets('Authorization: Bearer abcdef0123456789');
    expect(result).toBe('Authorization: Bearer [REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Regression cases for items 1–3 (spec #3918)
// ---------------------------------------------------------------------------

describe('regression — bare Bearer token (item 1)', () => {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.somePayload.signature';
  const text = `API error: Bearer ${token} was rejected`;

  it('redactSecrets removes bare Bearer token', () => {
    const result = redactSecrets(text);
    expect(result).not.toContain(token);
    expect(result).toContain('[REDACTED]');
  });

  it('redactInlineSecrets removes bare Bearer token', () => {
    const result = redactInlineSecrets(text);
    expect(result).not.toContain(token);
  });
});

describe('regression — short sk-ant payload (item 2, 8-char floor)', () => {
  const key = 'sk-ant-abcdefgh12345678';
  const text = `set key ${key} in config`;

  it('redactSecrets removes short sk-ant key (8-char payload)', () => {
    const result = redactSecrets(text);
    expect(result).not.toContain(key);
    expect(result).toContain('[REDACTED]');
  });

  it('redactInlineSecrets removes short sk-ant key', () => {
    const result = redactInlineSecrets(text);
    expect(result).not.toContain(key);
  });
});

describe('regression — Telegram token inside /bot URL (item 3)', () => {
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  const text = `https://api.telegram.org/bot${token}/getMe`;

  it('redactSecrets removes Telegram token inside /bot URL', () => {
    const result = redactSecrets(text);
    expect(result).not.toContain(token);
    expect(result).toContain('[REDACTED]');
  });

  it('redactInlineSecrets removes Telegram token inside /bot URL', () => {
    const result = redactInlineSecrets(text);
    expect(result).not.toContain(token);
  });
});
