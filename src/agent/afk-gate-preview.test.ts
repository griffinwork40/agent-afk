import { describe, it, expect } from 'vitest';
import { previewInput, buildInputPreview, PREVIEW_BUDGET, LABEL_OVERHEAD } from './afk-gate-preview.js';

/** Half derived from the default budget and label overhead, matching the implementation. */
const DEFAULT_HALF = Math.floor((PREVIEW_BUDGET - LABEL_OVERHEAD) / 2);

describe('previewInput', () => {
  it('returns an empty string for an empty input', () => {
    expect(previewInput('')).toBe('');
  });

  it('returns short input verbatim (under budget)', () => {
    const short = 'rm -rf /important';
    expect(previewInput(short)).toBe(short);
  });

  it('returns input at exactly the budget boundary verbatim', () => {
    const exact = 'x'.repeat(PREVIEW_BUDGET);
    expect(previewInput(exact)).toBe(exact);
  });

  it('middle-truncates long input — head and tail both survive', () => {
    const head = 'HEAD'.repeat(200);    // 800 chars
    const middle = 'MIDDLE'.repeat(500); // 3000 chars (filler, fully omitted)
    const tail = 'TAIL'.repeat(200);    // 800 chars
    const long = head + middle + tail;

    const result = previewInput(long);
    expect(result.startsWith(head.slice(0, DEFAULT_HALF))).toBe(true);
    expect(result.endsWith(tail.slice(tail.length - DEFAULT_HALF))).toBe(true);
  });

  it('middle-truncated result contains the omitted character count', () => {
    const s = 'A'.repeat(PREVIEW_BUDGET + 1000);
    const result = previewInput(s);
    const omitted = s.length - DEFAULT_HALF * 2;
    expect(result).toContain(`${omitted} chars omitted`);
    expect(result.length).toBeLessThanOrEqual(PREVIEW_BUDGET);
  });

  it('does not exceed budget when string is exactly one char over budget', () => {
    // half = floor((PREVIEW_BUDGET - LABEL_OVERHEAD) / 2).
    // A string of PREVIEW_BUDGET+1 chars triggers truncation.
    const s = 'X'.repeat(PREVIEW_BUDGET + 1);
    const result = previewInput(s);
    const omitted = s.length - DEFAULT_HALF * 2;
    expect(result).toContain(`${omitted} chars omitted`);
    expect(result.length).toBeLessThanOrEqual(PREVIEW_BUDGET);
  });

  it('respects a custom budget', () => {
    const s = 'hello world this is a long string';
    // budget=10 is smaller than LABEL_OVERHEAD (32) — falls back to a plain head slice
    expect(previewInput(s, 10)).toBe(s.slice(0, 10));
    expect(previewInput(s, 10).length).toBeLessThanOrEqual(10);
    // budget=s.length — string fits verbatim
    expect(previewInput(s, s.length)).toBe(s);
    // budget large enough for label but smaller than the string
    const long = 'x'.repeat(200);
    expect(previewInput(long, 100)).toContain('chars omitted');
    expect(previewInput(long, 100).length).toBeLessThanOrEqual(100);
  });

  it('output never exceeds budget chars for a small custom budget', () => {
    // Previously PREVIEW_HALF was a fixed constant (700), so previewInput(s, 10)
    // could emit up to 1400 chars — longer than the requested budget.
    // A later fix derived half from budget alone but omitted the label overhead,
    // so previewInput(s, 10) still emitted 36 chars (10 chars + 26-char label).
    const s = 'A'.repeat(5000);
    const budget = 100;
    const result = previewInput(s, budget);
    // half = floor((100 - 32) / 2) = 34
    const half = Math.floor((budget - LABEL_OVERHEAD) / 2);
    expect(result.startsWith('A'.repeat(half))).toBe(true);
    expect(result.endsWith('A'.repeat(half))).toBe(true);
    expect(result).toContain('chars omitted');
    expect(result.length).toBeLessThanOrEqual(budget);
  });
});

describe('buildInputPreview', () => {
  it('returns empty string for an empty string input', () => {
    expect(buildInputPreview('')).toBe('');
  });

  it('passes a string input through verbatim when under budget', () => {
    const s = 'some command';
    expect(buildInputPreview(s)).toBe(s);
  });

  it('middle-truncates a long string so both ends survive', () => {
    // Construct a string with a destructive tail past the first 300 chars
    // (the old MAX_INPUT_PREVIEW that hid the tail).
    // 'safe '.repeat(500) = 2500 chars of innocuous preamble, well over PREVIEW_BUDGET.
    const prefix = 'safe '.repeat(500);    // 2500 chars of innocuous preamble
    const dangerous = '; rm -rf /important'; // destructive tail
    const s = prefix + dangerous;
    expect(s.length).toBeGreaterThan(PREVIEW_BUDGET);

    const result = buildInputPreview(s);
    // Tail (dangerous part) must be visible
    expect(result).toContain('rm -rf /important');
    // Head must be present
    expect(result).toContain(prefix.slice(0, 50));
    // Omission label must be present
    expect(result).toContain('chars omitted');
  });
});
