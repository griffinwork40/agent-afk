import { describe, it, expect } from 'vitest';
import {
  extractionAdvisory,
  visibleTextLength,
  withAdvisory,
  MIN_SOURCE_TEXT_CHARS,
  MIN_RETAINED_RATIO,
} from './extraction-advisory.js';

/** Build an html document whose visible text is roughly `chars` long. */
function htmlWithText(chars: number): string {
  return `<html><body><p>${'word '.repeat(Math.ceil(chars / 5))}</p></body></html>`;
}

describe('visibleTextLength', () => {
  it('excludes script and style payloads from the count', () => {
    const noisy =
      '<html><head><style>' +
      'a{color:red}'.repeat(500) +
      '</style></head><body><script>' +
      'var x=1;'.repeat(500) +
      '</script><p>hello world</p></body></html>';

    // Only "hello world" is visible; the inline payloads must not inflate it.
    expect(visibleTextLength(noisy)).toBeLessThan(40);
  });

  it('excludes html comments and tag markup', () => {
    expect(visibleTextLength('<!-- a long hidden comment --><p><b>hi</b></p>')).toBe(2);
  });

  it('is 0 for an empty document', () => {
    expect(visibleTextLength('')).toBe(0);
  });

  it('handles many unmatched hidden-block openers in one linear scan', () => {
    const malformed = `<p>visible</p>${'<script>'.repeat(40_000)}`;
    expect(visibleTextLength(malformed)).toBe(7);
  });
});

describe('extractionAdvisory', () => {
  it('fires when a large page retains well under the ratio floor', () => {
    const html = htmlWithText(10_000);
    const advisory = extractionAdvisory({ html, extractedTextLength: 1_000 });

    expect(advisory).toBeDefined();
    // Must name the numbers, the cause, and the remedy — a bare warning would
    // just invite the same retry it exists to prevent.
    expect(advisory).toContain('%');
    expect(advisory).toContain('collapsed');
    expect(advisory).toContain('mode: "raw"');
    expect(advisory).toContain('1000');
  });

  it('stays silent when extraction retained most of the visible text', () => {
    const html = htmlWithText(10_000);
    // ~90% retained: ordinary boilerplate stripping, extraction working.
    expect(extractionAdvisory({ html, extractedTextLength: 9_000 })).toBeUndefined();
  });

  it('stays silent just above the ratio floor and fires just below it', () => {
    const html = htmlWithText(10_000);
    const source = visibleTextLength(html);
    const justAbove = Math.ceil(source * (MIN_RETAINED_RATIO + 0.02));
    const justBelow = Math.floor(source * (MIN_RETAINED_RATIO - 0.02));

    expect(extractionAdvisory({ html, extractedTextLength: justAbove })).toBeUndefined();
    expect(extractionAdvisory({ html, extractedTextLength: justBelow })).toBeDefined();
  });

  it('stays silent on a small document even at low retention', () => {
    // Below the absolute floor the ratio is noise, and the existing
    // THIN_CONTENT_CHARS render escalation already covers tiny results.
    const html = htmlWithText(MIN_SOURCE_TEXT_CHARS - 500);
    expect(visibleTextLength(html)).toBeLessThan(MIN_SOURCE_TEXT_CHARS);
    expect(extractionAdvisory({ html, extractedTextLength: 10 })).toBeUndefined();
  });

  it('handles degenerate input without dividing by zero', () => {
    expect(extractionAdvisory({ html: '', extractedTextLength: 0 })).toBeUndefined();
    expect(extractionAdvisory({ html: '', extractedTextLength: 500 })).toBeUndefined();
  });

  it('stays silent when extraction reports more text than the source had', () => {
    const html = htmlWithText(10_000);
    expect(extractionAdvisory({ html, extractedTextLength: 99_999 })).toBeUndefined();
  });
});

describe('withAdvisory', () => {
  it('returns the body unchanged when there is no advisory', () => {
    expect(withAdvisory('body', undefined)).toBe('body');
    expect(withAdvisory('body', '')).toBe('body');
  });

  it('appends the advisory below the body', () => {
    expect(withAdvisory('body', '[note]')).toBe('body\n\n[note]');
  });
});
