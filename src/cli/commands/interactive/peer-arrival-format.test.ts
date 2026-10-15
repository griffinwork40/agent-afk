import { describe, expect, it } from 'vitest';
import { displayWidth, stripAnsi } from '../../display.js';
import { formatPeerArrival, safePeerSender } from './peer-arrival-format.js';

const from = { id: 'abcdefgh-more', name: 'Alice' };
describe('peer arrival presentation', () => {
  it('attributes and previews normalized text', () => {
    expect(stripAnsi(formatPeerArrival({ from, body: 'hello\n\t world' }, 80)))
      .toBe('↘ peer message from Alice · "hello world"');
  });
  it.each([undefined, '', ' \t ', '\x1b[31m\x07'])('falls back after sanitizing name %j', (name) => {
    expect(safePeerSender({ id: 'abcdefgh-more', name })).toBe('abcdefgh');
  });
  it('sanitizes the abbreviated fallback too', () => {
    expect(safePeerSender({ id: '\x07abc\rdefghi' })).toBe('abc def');
  });
  it.each(['\x1b[31mred\x1b[0m', '\x1b]8;;https://bad\x07link\x1b]8;;\x07',
    'a\rb\bc\x7fd\x85e', 'a\n\t  b'])('neutralizes controls in identity and body: %j', (raw) => {
    const line = stripAnsi(formatPeerArrival({ from: { id: 'id', name: raw }, body: raw }, 100));
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).not.toContain('https://bad');
    expect(line).not.toContain('  ');
  });
  it.each(['', ' \t\n', '\x07\x1b[31m'])('omits empty preview punctuation: %j', (body) => {
    expect(stripAnsi(formatPeerArrival({ from, body }, 80))).toBe('↘ peer message from Alice');
  });
  it.each(['a'.repeat(200), '界'.repeat(100), '👩‍💻'.repeat(100), 'e\u0301'.repeat(100)])(
    'bounds styled Unicode receipts at every small width', (text) => {
      for (let width = 0; width <= 120; width++) {
        const line = formatPeerArrival({ from: { id: 'id', name: text }, body: text }, width);
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
        const plain = stripAnsi(line);
        expect(plain.includes('"')).toBe(plain.includes('"'));
      }
    });
  it('drops preview before truncating attribution', () => {
    expect(stripAnsi(formatPeerArrival({ from, body: 'hello' }, displayWidth('↘ peer message from Alice')))).toBe('↘ peer message from Alice');
    expect(formatPeerArrival({ from, body: 'hello' }, 0)).toBe('');
  });
});
