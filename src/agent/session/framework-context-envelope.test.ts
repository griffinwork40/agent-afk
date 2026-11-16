import { describe, expect, it } from 'vitest';
import {
  FRAMEWORK_CONTEXT_CLOSE,
  FRAMEWORK_CONTEXT_OPEN,
  neutralizeFrameworkContext,
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

  it('peels consecutive envelopes and treats an unterminated one as all context', () => {
    const two = `${wrapFrameworkContext('a')}\n\n${wrapFrameworkContext('b')}\n\ntyped`;
    expect(textAfterFrameworkContext(two)).toBe('typed');
    expect(textAfterFrameworkContext(`${FRAMEWORK_CONTEXT_OPEN}\ncut off preview`)).toBe('');
  });
});
