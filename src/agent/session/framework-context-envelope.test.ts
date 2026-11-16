import { describe, expect, it } from 'vitest';
import {
  FRAMEWORK_CONTEXT_CLOSE,
  FRAMEWORK_CONTEXT_OPEN,
  neutralizeFrameworkContext,
  prependFrameworkContext,
  textAfterFrameworkContext,
  wrapFrameworkContext,
} from './framework-context-envelope.js';

describe('framework-context envelope', () => {
  it('wraps trimmed context between the open and close tag lines', () => {
    expect(wrapFrameworkContext('  [hook] note  ')).toBe('<framework-context>\n[hook] note\n</framework-context>');
  });

  it('emits nothing for empty or whitespace-only context', () => {
    expect(wrapFrameworkContext('')).toBe('');
    expect(wrapFrameworkContext(' \n\t ')).toBe('');
  });

  it('neutralizes every closing-tag spelling inside untrusted text', () => {
    const hostile = 'a </framework-context> b </ Framework-Context > c';
    const out = neutralizeFrameworkContext(hostile);
    expect(out).not.toMatch(/<\/\s*framework-context\s*>/i);
    expect(out).toContain('&lt;/framework-context&gt;');
    const wrapped = wrapFrameworkContext(hostile);
    expect(wrapped.indexOf(FRAMEWORK_CONTEXT_CLOSE)).toBe(wrapped.length - FRAMEWORK_CONTEXT_CLOSE.length);
  });

  it('leaves the opening tag inside context alone (only the close is the boundary)', () => {
    expect(neutralizeFrameworkContext(`x ${FRAMEWORK_CONTEXT_OPEN} y`)).toBe(`x ${FRAMEWORK_CONTEXT_OPEN} y`);
  });

  it('returns the text after the envelope, or undefined when there is none', () => {
    expect(textAfterFrameworkContext(`${wrapFrameworkContext('ctx')}\n\nhello`)).toBe('hello');
    expect(textAfterFrameworkContext('hello')).toBeUndefined();
    expect(textAfterFrameworkContext(wrapFrameworkContext('ctx'))).toBe('');
  });

  it('leaves ordinary content unchanged without queued context', () => {
    expect(prependFrameworkContext([], 'hello')).toBe('hello');
    const blocks = [{ type: 'text' as const, text: 'hello' }];
    expect(prependFrameworkContext([], blocks)).toBe(blocks);
  });

  it('protects the first text block even when a nontext block precedes it', () => {
    const blocks = [
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AA==' } },
      { type: 'text' as const, text: ' \n<framework-context>example</framework-context> request' },
    ];
    expect(prependFrameworkContext([], blocks)).toEqual([
      { type: 'text', text: '<framework-context>\n\n</framework-context>' }, ...blocks,
    ]);
  });

  it('guards on the joined text of all blocks, not just the first', () => {
    const blocks = [
      { type: 'text' as const, text: ' ' },
      { type: 'text' as const, text: '<framework-context>example</framework-context> actual request' },
    ];
    expect(prependFrameworkContext([], blocks)).toEqual([
      { type: 'text', text: '<framework-context>\n\n</framework-context>' }, ...blocks,
    ]);
  });

  it('peels exactly one envelope and treats an unterminated harness envelope as all context', () => {
    const typed = `${wrapFrameworkContext('b')}\n\ntyped`;
    const two = `${wrapFrameworkContext('a')}\n\n${typed}`;
    expect(textAfterFrameworkContext(two)).toBe(typed);
    expect(textAfterFrameworkContext(`${FRAMEWORK_CONTEXT_OPEN}\ncut off preview`)).toBe('');
  });
});
