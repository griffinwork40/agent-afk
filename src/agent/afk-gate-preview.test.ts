import { describe, it, expect } from 'vitest';
import { previewInput, buildInputPreview, PREVIEW_BUDGET, PREVIEW_HALF } from './afk-gate-preview.js';

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
    expect(result.startsWith(head.slice(0, PREVIEW_HALF))).toBe(true);
    expect(result.endsWith(tail.slice(tail.length - PREVIEW_HALF))).toBe(true);
  });

  it('middle-truncated result contains the omitted character count', () => {
    const s = 'A'.repeat(PREVIEW_BUDGET + 1000);
    const result = previewInput(s);
    const omitted = s.length - PREVIEW_HALF * 2;
    expect(result).toContain(`${omitted} chars omitted`);
  });

  it('does not middle-truncate when the string is exactly one char over budget', () => {
    // The head+tail halves each take PREVIEW_HALF chars, so a string of
    // PREVIEW_BUDGET+1 chars is too long but the omitted region is exactly
    // PREVIEW_BUDGET+1 - PREVIEW_HALF*2 = 1.
    const s = 'X'.repeat(PREVIEW_BUDGET + 1);
    const result = previewInput(s);
    const omitted = s.length - PREVIEW_HALF * 2;
    expect(result).toContain(`${omitted} chars omitted`);
  });

  it('respects a custom budget', () => {
    const s = 'hello world this is a long string';
    expect(previewInput(s, 10)).toContain('chars omitted');
    expect(previewInput(s, s.length)).toBe(s);
  });
});

describe('buildInputPreview', () => {
  it('returns empty string for an empty string input', () => {
    expect(buildInputPreview('')).toBe('');
  });

  it('JSON-stringifies null to the string "null" (not empty)', () => {
    // JSON.stringify(null) === 'null', which is a non-empty string.
    expect(buildInputPreview(null)).toBe('null');
  });

  it('stringifies non-string input via JSON.stringify', () => {
    const obj = { command: 'rm -rf /important; echo done' };
    const result = buildInputPreview(obj);
    expect(result).toContain('rm -rf /important');
    expect(result).toContain('echo done');
  });

  it('passes a string input through without double-encoding', () => {
    const s = 'some command';
    expect(buildInputPreview(s)).toBe(s);
  });

  it('middle-truncates a long JSON-stringified object so both ends survive', () => {
    // Construct an object whose JSON is long: a bash command with a destructive
    // tail past the first 300 chars (the old MAX_INPUT_PREVIEW that hid the tail).
    // 'safe '.repeat(500) = 2500 chars of innocuous preamble, well over PREVIEW_BUDGET.
    const prefix = 'safe '.repeat(500);    // 2500 chars of innocuous preamble
    const dangerous = '; rm -rf /important'; // destructive tail
    const obj = { command: prefix + dangerous };
    const json = JSON.stringify(obj);
    expect(json.length).toBeGreaterThan(PREVIEW_BUDGET);

    const result = buildInputPreview(obj);
    // Tail (dangerous part) must be visible
    expect(result).toContain('rm -rf /important');
    // Head must be present
    expect(result).toContain(prefix.slice(0, 50));
    // Omission label must be present
    expect(result).toContain('chars omitted');
  });
});
