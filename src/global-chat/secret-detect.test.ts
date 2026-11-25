import { describe, expect, it } from 'vitest';
import { detectSecrets, type SecretKind } from './secret-detect.js';

const samples: [SecretKind, string][] = [
  ['anthropic', 'sk-ant-' + 'a'.repeat(32)], ['openai', 'sk-proj-' + 'a'.repeat(32)],
  ['openai', 'sk-' + 'a1'.repeat(10)],
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'].map(prefix => ['github', prefix + 'a'.repeat(36)] as [SecretKind, string]),
  ['github', 'github_pat_' + 'a'.repeat(82)],
  ...['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-'].map(prefix => ['slack', prefix + '1234567890-1234567890-abc'] as [SecretKind, string]),
  ['aws', 'AKIA' + 'A1'.repeat(8)], ['aws', 'ASIA' + 'A1'.repeat(8)],
  ['google', 'AIza' + 'a'.repeat(35)], ['stripe', 'sk_live_' + 'a'.repeat(24)],
  ['stripe', 'rk_live_' + 'a'.repeat(24)], ['npm', 'npm_' + 'a'.repeat(36)],
  ['telegram', '1:' + 'a'.repeat(35)], ['telegram', '123456789:' + 'a'.repeat(35)], ['private_key', '-----BEGIN PRIVATE KEY-----'],
  ['private_key', '-----BEGIN RSA PRIVATE KEY-----'], ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aB_c-123'],
  ['bearer', 'Bearer ' + 'a'.repeat(20)],
];
describe('chat secret detector', () => {
  it.each(samples)('detects %s with UTF-16 spans', (kind, token) => {
    const text = `🎉 token: ${token} end`;
    const spans = detectSecrets(text);
    expect(spans).toEqual([{ kind, start: 10, end: 10 + token.length }]);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(token);
    expect(detectSecrets(text)).toEqual(spans);
  });
  it('returns non-overlapping ordered spans', () => {
    const token = 'sk-proj-' + 'a'.repeat(32);
    const text = `Bearer ${token} and npm_${'b'.repeat(36)}`;
    expect(detectSecrets(text)).toEqual([
      { kind: 'bearer', start: 0, end: 7 + token.length },
      { kind: 'npm', start: 12 + token.length, end: text.length },
    ]);
  });
  it.each([
    '', 'git SHA 70de4f406abcdef0123456789abcdef0123456789ab',
    'UUID 83ab0129-e169-492f-badc-e57c7bc5d2af', 'src/global-chat/crypto.ts',
    'https://example.com/path?q=1234567890123456789012345', '#abcdef #fff',
    'sk-learn is useful', 'the sk- prefix', 'v5.360.0 Node 22.1.0',
    'sk-learn-compatible-estimator-api',
    'a'.repeat(200), '0123456789abcdef'.repeat(5), 'AKIA short', 'npm_short',
  ])('leaves ordinary developer chat clean: %s', text => expect(detectSecrets(text)).toEqual([]));
});
