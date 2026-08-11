/**
 * Invariant under test: the mirror reproduces the textarea's text EXACTLY.
 *
 * The mirror is painted behind the textarea and the two are read as one image,
 * so any dropped or duplicated character shows up as ghosting under the caret.
 * These cases pin character-for-character fidelity (whitespace included) and
 * the classification that decides which runs get colour — plus the fact that
 * operator-typed text reaches the DOM as text, never as markup.
 */

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { tokenizeInput, paintMirror } from './slash-highlight.js';

const known = (name: string): boolean => name === '/mint' || name === '/diagnose';
const tok = (value: string) => tokenizeInput(value, known);
const text = (value: string): string => tok(value).map((t) => t.text).join('');

describe('tokenizeInput', () => {
  it('classifies a registered command as known', () => {
    expect(tok('/mint')).toEqual([{ text: '/mint', kind: 'known' }]);
  });

  it('classifies an unregistered slash token as slash-shaped only', () => {
    expect(tok('/nope')).toEqual([{ text: '/nope', kind: 'slash' }]);
  });

  it('leaves ordinary prose plain', () => {
    expect(tok('hello')).toEqual([{ text: 'hello', kind: 'plain' }]);
  });

  it('highlights a command followed by arguments', () => {
    expect(tok('/mint a feature')).toEqual([
      { text: '/mint', kind: 'known' },
      { text: ' ', kind: 'plain' },
      { text: 'a', kind: 'plain' },
      { text: ' ', kind: 'plain' },
      { text: 'feature', kind: 'plain' },
    ]);
  });

  it('does not treat a bare slash as a command', () => {
    expect(tok('/')).toEqual([{ text: '/', kind: 'plain' }]);
  });

  it('does not treat a path as a command', () => {
    expect(tok('src/foo.ts')).toEqual([{ text: 'src/foo.ts', kind: 'plain' }]);
  });

  it('returns nothing for an empty buffer', () => {
    expect(tok('')).toEqual([]);
  });

  // Fidelity: these are the cases where a dropped character would ghost.
  it.each([
    ['/mint a feature'],
    ['  leading and trailing  '],
    ['multi\nline\ntext'],
    ['tabs\there'],
    ['/mint\n/diagnose'],
    ['a  b   c'],
  ])('reproduces %j character-for-character', (value) => {
    expect(text(value)).toBe(value);
  });
});

describe('paintMirror', () => {
  const mirror = (): HTMLElement => {
    document.body.innerHTML = '<div id="m"></div>';
    return document.getElementById('m') as HTMLElement;
  };

  it('wraps known commands in an accent span', () => {
    const m = mirror();
    paintMirror(m, tok('/mint go'));
    expect(m.querySelector('.tok-known')?.textContent).toBe('/mint');
  });

  it('wraps unknown slash tokens in a dim span', () => {
    const m = mirror();
    paintMirror(m, tok('/nope'));
    expect(m.querySelector('.tok-slash')?.textContent).toBe('/nope');
  });

  it('leaves plain runs unwrapped', () => {
    const m = mirror();
    paintMirror(m, tok('just prose'));
    expect(m.querySelectorAll('span')).toHaveLength(0);
  });

  it('renders typed markup as text, never as elements', () => {
    const m = mirror();
    paintMirror(m, tok('<img src=x onerror=alert(1)>'));
    expect(m.querySelector('img')).toBeNull();
    expect(m.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('replaces prior content rather than appending', () => {
    const m = mirror();
    paintMirror(m, tok('/mint'));
    paintMirror(m, tok('/diagnose'));
    expect(m.querySelectorAll('.tok-known')).toHaveLength(1);
    expect(m.textContent?.startsWith('/diagnose')).toBe(true);
  });
});
