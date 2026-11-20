import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { sanitizeFrameContent } from './cup-frame-renderer.sanitize.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';

function measureLines(content: string): number {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return new CupFrameRenderer(stream).measure(content, 23).lineCount;
}

const introducers = [
  ['OSC 7-bit', '\x1b]'], ['OSC C1', '\x9d'],
  ['DCS 7-bit', '\x1bP'], ['DCS C1', '\x90'],
  ['PM 7-bit', '\x1b^'], ['PM C1', '\x9e'],
  ['APC 7-bit', '\x1b_'], ['APC C1', '\x9f'],
  ['SOS 7-bit', '\x1bX'], ['SOS C1', '\x98'],
] as const;

describe('unterminated frame string controls stay within their row', () => {
  it('preserves the spinner and typed-input rows after an unterminated OSC', () => {
    const input = 'thinking: see \x1b]8;;http://x partial\n⠋ working\n> my typed input';
    expect(sanitizeFrameContent(input)).toBe('thinking: see \n⠋ working\n> my typed input');
    expect(measureLines(input)).toBe(3);
  });

  for (const [label, introducer] of introducers) {
    for (const payload of ['payload text', '']) {
      it(`${label}: preserves later rows with ${payload ? 'an unterminated payload' : 'an empty payload'}`, () => {
        const input = `row1 ${introducer}${payload}\nrow2 text\nrow3 text`;
        expect(sanitizeFrameContent(input)).toBe('row1 \nrow2 text\nrow3 text');
        expect(measureLines(input)).toBe(3);
      });
    }
  }
});
