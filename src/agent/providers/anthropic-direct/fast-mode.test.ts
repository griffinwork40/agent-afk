import { describe, expect, it } from 'vitest';
import { buildRequestHeaders } from './auth.js';
import { buildRoundParams } from './loop/round-request.js';

const base = { model: 'claude-opus-5', maxTokens: 100, messages: [], system: null, tools: null } as const;

describe('Anthropic Fast wire pairing', () => {
  it('composes the beta deterministically and without duplicates', () => {
    const headers = buildRequestHeaders('oauth', 'sid', 'rid', true, true, true);
    expect(headers['anthropic-beta']?.split(',')).toEqual([
      'claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14',
      'extended-cache-ttl-2025-04-11', 'effort-2025-11-24', 'fast-mode-2026-02-01',
    ]);
  });
  it('pairs effective Fast intent with body speed', () => {
    expect(buildRoundParams({ ...base, fastMode: true })).toMatchObject({ speed: 'fast' });
    expect(buildRoundParams(base)).not.toHaveProperty('speed');
  });
});
