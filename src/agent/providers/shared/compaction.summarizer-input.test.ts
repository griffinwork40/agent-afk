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

  it('drops the middle, keeps the opening and the newest, and marks the omission', () => {
    const transcript = 'OPENING ' + 'o'.repeat(500) + ' MIDDLE ' + 'o'.repeat(500) + ' NEWEST';
    const out = capTranscriptForSummarizer(transcript, 100);
    expect(out).toContain('[Transcript middle omitted');
    expect(out.startsWith(transcript.slice(0, 20))).toBe(true);
    expect(out.startsWith('OPENING')).toBe(true);
    expect(out).not.toContain('MIDDLE');
    expect(out.endsWith(transcript.slice(-80))).toBe(true);
    expect(out.endsWith('NEWEST')).toBe(true);
  });

  it('reports the exact number of dropped characters', () => {
    const out = capTranscriptForSummarizer('x'.repeat(1_000), 100);
    expect(out).toContain('900 characters dropped');
  });
});

/** True when `s` contains a UTF-16 surrogate that is not part of a valid pair. */
function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Put a two-unit emoji so its high surrogate sits at index `at - 1` and its low at `at`. */
function emojiAcross(length: number, at: number): string {
  return 'a'.repeat(at - 1) + '\u{1F600}' + 'b'.repeat(length - at - 1);
}

describe('surrogate pairs at the cut points', () => {
  const EXCERPT_MARKER = /\[\.\.\. (\d+) chars elided \.\.\.\]/;
  const CAP_MARKER = /\[Transcript middle omitted: (\d+) characters dropped/;

  it('excerptHeadTail: emoji across the head cut keeps no half pair and an exact elided count', () => {
    // maxChars 100: head cut at 40, tail cut at 1000 - 60 = 940.
    const text = emojiAcross(1_000, 40);
    const out = excerptHeadTail(text, 100);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    const [head, tail] = out.split(EXCERPT_MARKER.exec(out)?.[0] ?? '');
    const elided = Number(EXCERPT_MARKER.exec(out)?.[1]);
    expect((head ?? '').trimEnd().length + elided + (tail ?? '').trimStart().length).toBe(text.length);
    expect(out.length).toBeLessThanOrEqual(excerptHeadTail('a'.repeat(1_000), 100).length);
  });

  it('excerptHeadTail: emoji across the tail cut keeps no half pair and an exact elided count', () => {
    const text = emojiAcross(1_000, 940);
    const out = excerptHeadTail(text, 100);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    const elided = Number(EXCERPT_MARKER.exec(out)?.[1]);
    const [head, tail] = out.split(EXCERPT_MARKER.exec(out)?.[0] ?? '');
    expect((head ?? '').slice(0, -1).length + elided + (tail ?? '').slice(1).length).toBe(text.length);
    expect(out.length).toBeLessThanOrEqual(excerptHeadTail('a'.repeat(1_000), 100).length);
  });

  it('capTranscriptForSummarizer: emoji across the opening cut keeps no half pair and an exact dropped count', () => {
    // maxChars 100: opening cut at 20, newest cut at 1000 - 80 = 920.
    const text = emojiAcross(1_000, 20);
    const out = capTranscriptForSummarizer(text, 100);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    const dropped = Number(CAP_MARKER.exec(out)?.[1]);
    const opening = out.slice(0, out.indexOf('\n\n['));
    const newest = out.slice(out.lastIndexOf(']\n\n') + 3);
    expect(opening.length + dropped + newest.length).toBe(text.length);
    expect(out.length).toBeLessThanOrEqual(capTranscriptForSummarizer('a'.repeat(1_000), 100).length);
  });

  it('capTranscriptForSummarizer: emoji across the newest cut keeps no half pair and an exact dropped count', () => {
    const text = emojiAcross(1_000, 920);
    const out = capTranscriptForSummarizer(text, 100);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    const dropped = Number(CAP_MARKER.exec(out)?.[1]);
    const opening = out.slice(0, out.indexOf('\n\n['));
    const newest = out.slice(out.lastIndexOf(']\n\n') + 3);
    expect(opening.length + dropped + newest.length).toBe(text.length);
    expect(out.length).toBeLessThanOrEqual(capTranscriptForSummarizer('a'.repeat(1_000), 100).length);
  });

  it('never emits a half pair for any budget on emoji-dense input', () => {
    const text = 'x' + '\u{1F600}'.repeat(300) + 'y';
    for (let budget = 1; budget < 120; budget++) {
      const ex = excerptHeadTail(text, budget);
      const cap = capTranscriptForSummarizer(text, budget);
      expect(hasUnpairedSurrogate(ex)).toBe(false);
      expect(hasUnpairedSurrogate(cap)).toBe(false);
      expect(ex.replace(EXCERPT_MARKER, '').length).toBeLessThanOrEqual(budget + 2);
      expect(cap.replace(/\n\n\[Transcript middle omitted[^\]]*\]\n\n/, '').length).toBeLessThanOrEqual(budget);
    }
  });

  it('leaves ASCII output byte-identical to the plain slice behaviour', () => {
    const text = 'HEAD' + 'abcdefghij'.repeat(200) + 'TAIL';
    const headLen = Math.floor(100 * 0.4);
    expect(excerptHeadTail(text, 100)).toBe(
      `${text.slice(0, headLen)} [... ${text.length - 100} chars elided ...] ${text.slice(text.length - 60)}`,
    );
    expect(capTranscriptForSummarizer(text, 100)).toBe(
      text.slice(0, 20) +
        `\n\n[Transcript middle omitted: ${text.length - 100} characters dropped to fit the ` +
        'summarizer context budget. The opening above and the newest content below are kept.]\n\n' +
        text.slice(text.length - 80),
    );
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
