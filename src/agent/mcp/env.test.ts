import { describe, it, expect } from 'vitest';

import { expandEnvRecord, expandEnvString } from './env.js';

describe('expandEnvString', () => {
  it('returns the input unchanged when no placeholders are present', () => {
    expect(expandEnvString('plain-string', {})).toEqual({
      value: 'plain-string',
      missing: [],
    });
  });

  it('expands `${VAR}` from the supplied env source', () => {
    const result = expandEnvString('Bearer ${TOKEN}', { TOKEN: 'sk-123' });
    expect(result.value).toBe('Bearer sk-123');
    expect(result.missing).toEqual([]);
  });

  it('records missing variables instead of failing', () => {
    const result = expandEnvString('${A}/${B}', { A: 'foo' });
    expect(result.value).toBe('foo/');
    expect(result.missing).toEqual(['B']);
  });

  it('treats empty-string values as missing', () => {
    const result = expandEnvString('${TOKEN}', { TOKEN: '' });
    expect(result.value).toBe('');
    expect(result.missing).toEqual(['TOKEN']);
  });

  it('escapes `$${VAR}` to literal `${VAR}`', () => {
    const result = expandEnvString('$${LITERAL}', { LITERAL: 'unused' });
    expect(result.value).toBe('${LITERAL}');
    expect(result.missing).toEqual([]);
  });

  it('handles multiple placeholders in one string', () => {
    const result = expandEnvString('${A}-${B}-${A}', { A: 'x', B: 'y' });
    expect(result.value).toBe('x-y-x');
  });
});

describe('expandEnvRecord', () => {
  it('expands every value, leaving keys untouched', () => {
    const result = expandEnvRecord(
      { Authorization: 'Bearer ${TOKEN}', 'X-User': 'static' },
      { TOKEN: 'abc' },
    );
    expect(result.value).toEqual({ Authorization: 'Bearer abc', 'X-User': 'static' });
    expect(result.missing).toEqual([]);
  });

  it('aggregates and de-duplicates missing variables', () => {
    const result = expandEnvRecord(
      { A: '${X}', B: '${X}', C: '${Y}' },
      {},
    );
    expect(result.missing.sort()).toEqual(['X', 'Y']);
  });

  it('returns empty result for undefined input', () => {
    expect(expandEnvRecord(undefined)).toEqual({ value: {}, missing: [] });
  });
});
