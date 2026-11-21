import { describe, it, expect } from 'vitest';
import { parseKeys, splitPending } from './global-chat-keys.js';

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

describe('splitPending (escape and paste split across reads)', () => {
  it('holds a trailing lone ESC or an unfinished CSI', () => {
    expect(splitPending('\x1b')).toEqual({ ready: '', pending: '\x1b' });
    expect(splitPending('ab\x1b[5')).toEqual({ ready: 'ab', pending: '\x1b[5' });
    expect(splitPending('\x1b[5~')).toEqual({ ready: '\x1b[5~', pending: '' });
    expect(splitPending('x\x1b[Ay')).toEqual({ ready: 'x\x1b[Ay', pending: '' });
  });
  it('holds an unfinished bracketed paste until its end marker', () => {
    expect(splitPending('\x1b[200~half')).toEqual({ ready: '', pending: '\x1b[200~half' });
    expect(splitPending('\x1b[200~a\x1b[201~')).toEqual({ ready: '\x1b[200~a\x1b[201~', pending: '' });
  });
});
