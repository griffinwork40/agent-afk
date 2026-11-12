/**
 * Tests for the summarizer-input helpers: head-and-tail excerpts, the
 * transcript cap, the model-derived budget, and the structured prompt.
 */
import { describe, it, expect } from 'vitest';
import {
  COMPACT_SUMMARY_MAX_TOKENS,
  COMPACT_SYSTEM_PROMPT,
  capTranscriptForSummarizer,
  excerptHeadTail,
  summarizerInputCharBudget,
} from './compaction.summarizer-input.js';
import { contextLimitFor } from '../../model-limits.js';

describe('excerptHeadTail', () => {
  it('returns short input unchanged', () => {
    expect(excerptHeadTail('short text', 100)).toBe('short text');
    expect(excerptHeadTail('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  it('keeps both ends of long input with an elision marker', () => {
    const text = 'BEGIN' + 'm'.repeat(5_000) + 'END-ERROR';
    const out = excerptHeadTail(text, 200);
    expect(out.startsWith('BEGIN')).toBe(true);
    expect(out.endsWith('END-ERROR')).toBe(true);
    expect(out).toMatch(/\[\.\.\. \d+ chars elided \.\.\.\]/);
    expect(out.length).toBeLessThan(260);
  });

  it('reports the exact number of elided characters', () => {
    const out = excerptHeadTail('a'.repeat(1_000), 100);
    expect(out).toContain('[... 900 chars elided ...]');
  });
});

describe('capTranscriptForSummarizer', () => {
  it('returns the transcript unchanged when under budget or uncapped', () => {
    expect(capTranscriptForSummarizer('abc', 10)).toBe('abc');
    expect(capTranscriptForSummarizer('abc', undefined)).toBe('abc');
  });

  it('drops the oldest text, keeps the newest, and marks the omission', () => {
    const transcript = 'OLDEST ' + 'o'.repeat(500) + ' NEWEST';
    const out = capTranscriptForSummarizer(transcript, 100);
    expect(out).toContain('[Earlier transcript omitted');
    expect(out).not.toContain('OLDEST');
    expect(out.endsWith('NEWEST')).toBe(true);
    expect(out.endsWith(transcript.slice(-100))).toBe(true);
  });
});

describe('summarizerInputCharBudget', () => {
  it('derives about half the summarizer model window, in characters', () => {
    const window = contextLimitFor('claude-haiku-4-5-20251001');
    expect(summarizerInputCharBudget('claude-haiku-4-5-20251001')).toBe(Math.floor(window * 0.5 * 3));
  });

  it('follows the model passed in, not a fixed constant', () => {
    expect(summarizerInputCharBudget('gpt-4o')).toBe(Math.floor(contextLimitFor('gpt-4o') * 0.5 * 3));
  });
});

describe('COMPACT_SYSTEM_PROMPT', () => {
  it('asks for the fixed labelled sections and drops the word target', () => {
    for (const label of [
      'GOAL AND CONSTRAINTS:',
      'PROGRESS:',
      'DECISIONS:',
      'FILES AND COMMANDS:',
      'CURRENT STATE AND NEXT STEP:',
      'OPEN QUESTIONS:',
    ]) {
      expect(COMPACT_SYSTEM_PROMPT).toContain(label);
    }
    expect(COMPACT_SYSTEM_PROMPT).toContain('Do not invent details');
    expect(COMPACT_SYSTEM_PROMPT).not.toMatch(/~?\d+ words/);
  });

  it('uses a single summary output budget of about 2,000 tokens', () => {
    expect(COMPACT_SUMMARY_MAX_TOKENS).toBe(2_000);
  });
});
