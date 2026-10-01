import { describe, it, expect } from 'vitest';
import { LineClassifier } from './smoke-reveal.lines.js';
import { splitAtHeadingBoundary } from './markdown-stream.heading-hold.js';

const headingText = (c: LineClassifier, chunks: string[]): string =>
  chunks.flatMap((ch) => c.split(ch)).filter((r) => r.heading).map((r) => r.text).join('');

describe('LineClassifier', () => {
  it('splits heading lines from body text and round-trips the chunk', () => {
    const c = new LineClassifier();
    const chunk = 'intro\n## Title here\nbody\n';
    const runs = c.split(chunk);
    expect(runs.map((r) => r.text).join('')).toBe(chunk);
    expect(runs.filter((r) => r.heading).map((r) => r.text)).toEqual(['## Title here\n']);
  });

  it('carries line state across chunk boundaries', () => {
    expect(headingText(new LineClassifier(), ['## The Light', "house Keeper's", ' Visitor\n', 'body'])).toBe(
      "## The Lighthouse Keeper's Visitor\n",
    );
  });

  it('guesses a truncated heading marker, and never treats fenced lines as headings', () => {
    expect(headingText(new LineClassifier(), ['##', ' Title\n'])).toBe('## Title\n');
    expect(headingText(new LineClassifier(), ['```\n# comment\n```\n# Real\n'])).toBe('# Real\n');
  });

  it('does not treat #hashtags as headings', () => {
    expect(headingText(new LineClassifier(), ['#hashtag here\n'])).toBe('');
  });

  // Bold-only title detection: the first non-blank line that starts with ** or *
  // is treated as a heading for the smoke accent. Models frequently respond with
  // a bold title instead of a # heading, so without this the accent never fires.
  it('treats a bold-only first line (**text) as a heading', () => {
    const c = new LineClassifier();
    expect(headingText(c, ['**Summary of Results**\n', 'Body follows here.'])).toBe('**Summary of Results**\n');
  });

  it('treats a bold-only first line streamed across chunks as a heading', () => {
    // The line starts with ** even though it arrives across two chunks.
    expect(headingText(new LineClassifier(), ['**Key', ' Finding**\n', 'Body text.'])).toBe('**Key Finding**\n');
  });

  it('treats italic-only first line (*text) as a heading', () => {
    const c = new LineClassifier();
    expect(headingText(c, ['*Note*\n', 'Body follows.'])).toBe('*Note*\n');
  });

  it('does not treat a bold first line if blank lines precede it', () => {
    // A blank first line keeps firstLine=true; the bold line is still first non-blank.
    const c = new LineClassifier();
    expect(headingText(c, ['\n**Title**\n', 'Body.'])).toBe('**Title**\n');
  });

  it('does not treat bold words mid-paragraph as headings', () => {
    // Bold text on a NON-first line should not trigger the accent.
    const c = new LineClassifier();
    const runs = c.split('First line of prose.\nNext line has **bold** word.\n');
    const headingRuns = runs.filter((r) => r.heading);
    expect(headingRuns).toHaveLength(0);
  });

  it('does not treat bold text on second+ lines as headings (firstLine consumed)', () => {
    const c = new LineClassifier();
    // First non-blank line is plain text → firstLine consumed.
    expect(headingText(c, ['Plain first line.\n', '**Not a heading**\n', 'Body.'])).toBe('');
  });
});

describe('splitAtHeadingBoundary', () => {
  it('splits exactly before the character that completes a heading block', () => {
    expect(splitAtHeadingBoundary('', '## Title\n\nBody')).toEqual({ now: '## Title\n', held: '\nBody' });
    expect(splitAtHeadingBoundary('## Title\n', '\nBody')).toEqual({ now: '', held: '\nBody' });
  });

  it('ignores paragraph boundaries and chunks that complete nothing', () => {
    expect(splitAtHeadingBoundary('', 'Paragraph.\n\nNext')).toBeNull();
    expect(splitAtHeadingBoundary('', '## Title\nstill going')).toBeNull();
  });

  it('holds a bold-only title block (single line, starts with **)', () => {
    // A bold-only first line: the single-line block should be held.
    expect(splitAtHeadingBoundary('', '**Summary**\n\nBody')).toEqual({ now: '**Summary**\n', held: '\nBody' });
  });

  it('holds a bold title only as the first block, never a later bold paragraph', () => {
    // A later one-line bold block gets no smoke (LineClassifier's first-line
    // window), so holding it would be a pause with no visible effect.
    expect(splitAtHeadingBoundary('', '**Done**\n\nNext', false)).toBeNull();
    // Real `#` headings are held anywhere in the response.
    expect(splitAtHeadingBoundary('', '## Later\n\nBody', false)).toEqual({ now: '## Later\n', held: '\nBody' });
  });

  it('does not hold a multi-line bold block', () => {
    // Multi-line block starting with bold: only single-row bold titles are held.
    expect(splitAtHeadingBoundary('', '**Line one**\nLine two\n\nBody')).toBeNull();
  });
});
