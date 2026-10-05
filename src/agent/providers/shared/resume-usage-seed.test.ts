import { describe, it, expect } from 'vitest';
import type { JournalMessage } from '../../journal/index.js';
import { BINARY_TOKEN_ESTIMATE, estimateJournalInputTokens, resumeSeedInputTokens } from './resume-usage-seed.js';
import { estimateInputTokens } from './rate-limit-bucket.js';

const big: JournalMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'x'.repeat(350_000) }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
];

describe('resumeSeedInputTokens (#1294 overflow-guard seed)', () => {
  it('prefers the recorded sidecar count', () => {
    expect(resumeSeedInputTokens({ resumeHistory: [{ user: 'u', assistant: 'a', inputTokens: 1234 }], resumeMessages: big })).toBe(1234);
  });

  it('estimates from resumeMessages when the sidecar has no count', () => {
    const est = resumeSeedInputTokens({ resumeMessages: big });
    expect(est).toBe(estimateInputTokens(JSON.stringify(big)));
    expect(est).toBeGreaterThan(100_000); // over-estimates rather than under
    expect(resumeSeedInputTokens({ resumeHistory: [{ user: 'u', assistant: 'a' }], resumeMessages: big })).toBe(est);
  });

  it('is undefined when nothing was resumed', () => {
    expect(resumeSeedInputTokens({})).toBeUndefined();
    expect(resumeSeedInputTokens({ resumeMessages: [] })).toBeUndefined();
  });

  it('counts binaries at a flat estimate, not by base64 length', () => {
    const img: JournalMessage[] = [
      { role: 'user', content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'A'.repeat(4_000_000) } }] },
    ];
    const est = estimateJournalInputTokens(img);
    expect(est).toBeLessThan(10_000);
    expect(est).toBeGreaterThanOrEqual(BINARY_TOKEN_ESTIMATE);
  });
});
