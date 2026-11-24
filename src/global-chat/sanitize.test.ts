import { describe, expect, it } from 'vitest';
import { countLinks, sanitizeChatName, sanitizeChatText } from './sanitize.js';

describe('chat sanitation', () => {
  it.each([
    ['\x1b[31mred\x1b[0m', 'red'],
    ['\x1b]8;;https://evil.example\x07link\x1b]8;;\x07', 'link'],
    ['a\x1bPprivate\x1b\\b', 'ab'], ['a\x9b2Jb', 'ab'],
    ['a\x00b\x7fc\x85d', 'a b c d'], ['a\r\nb\tc\u2028d\u2029e', 'a b c d e'],
    [' a\x1b', 'a'], ['a\x1b\u200b[31mb', 'ab'],
  ])('strips unsafe content %j', (input, expected) => {
    expect(sanitizeChatText(input)).toBe(expected);
    expect(sanitizeChatName(input)).toBe(expected);
    expect(sanitizeChatText(sanitizeChatText(input))).toBe(expected);
  });
  it('removes every required invisible and bidi control', () => {
    const points = [0x061c, 0x200e, 0x200f, 0x2060, 0xfeff, 0x00ad, 0x180e];
    for (const [start, end] of [[0x202a, 0x202e], [0x2066, 0x2069], [0x200b, 0x200d], [0xe0000, 0xe007f]]) {
      for (let cp = start!; cp <= end!; cp++) points.push(cp);
    }
    for (const point of points) expect(sanitizeChatText(`a${String.fromCodePoint(point)}b`)).toBe('ab');
  });
  it.each(['hello  world', 'café 日本語 🎉', 'text ❤️', 'v1.2.3', 'https://example.com/a?b=2'])
    ('keeps clean text unchanged: %s', text => expect(sanitizeChatText(text)).toBe(text));
  it('counts explicit links consistently', () => {
    expect(countLinks('No URLs here, src/index.ts and example.com')).toBe(0);
    expect(countLinks('[docs](https://a.example) HTTP://b.example www.c.example')).toBe(3);
    expect(countLinks('https://www.example.com')).toBe(1);
  });
});
