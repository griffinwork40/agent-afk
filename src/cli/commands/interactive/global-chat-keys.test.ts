import { describe, it, expect } from 'vitest';
import { parseKeys } from './global-chat-keys.js';

describe('parseKeys', () => {
  it('maps control keys', () => {
    expect(parseKeys('\x1b')).toEqual([{ kind: 'escape' }]);
    expect(parseKeys('ab\x03')).toEqual([{ kind: 'interrupt' }]);
    expect(parseKeys('\r')).toEqual([{ kind: 'enter' }]);
    expect(parseKeys('\r\n')).toEqual([{ kind: 'enter' }]);
    expect(parseKeys('\x7f')).toEqual([{ kind: 'backspace' }]);
    expect(parseKeys('\b')).toEqual([{ kind: 'backspace' }]);
    expect(parseKeys('\x15')).toEqual([{ kind: 'clear' }]);
  });
  it('maps scroll keys including shift arrows', () => {
    expect(parseKeys('\x1b[5~')).toEqual([{ kind: 'pageUp' }]);
    expect(parseKeys('\x1b[6~')).toEqual([{ kind: 'pageDown' }]);
    expect(parseKeys('\x1b[1;2A')).toEqual([{ kind: 'lineUp' }]);
    expect(parseKeys('\x1b[1;2B')).toEqual([{ kind: 'lineDown' }]);
  });
  it('drops unknown escape sequences and keeps surrounding text', () => {
    expect(parseKeys('a\x1b[Ab')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]);
    expect(parseKeys('\x1b]52;c;eA==\x07')).toEqual([]);
    expect(parseKeys('\x01')).toEqual([]);
  });
  it('treats pastes and chunks containing line breaks as text, never enter', () => {
    expect(parseKeys('\x1b[200~x\ny\x1b[201~')).toEqual([{ kind: 'text', text: '\x1b[200~x\ny\x1b[201~' }]);
    expect(parseKeys('one\ntwo')).toEqual([{ kind: 'text', text: 'one\ntwo' }]);
    expect(parseKeys('hi\r')).toEqual([{ kind: 'text', text: 'hi\r' }]);
  });
});
