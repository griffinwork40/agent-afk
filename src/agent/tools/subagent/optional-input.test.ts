/**
 * Unit tests for the blank-tolerant optional-field readers.
 *
 * The contract under test: for an OPTIONAL field, blank (`undefined`, `null`,
 * whitespace-only string) is indistinguishable from omitted, while a
 * wrong-TYPED value still rejects loudly. Blank-collapse must not become
 * type coercion.
 */

import { describe, it, expect } from 'vitest';
import {
  isBlankInput,
  readOptional,
  readOptionalAliasString,
  readOptionalNumber,
  readOptionalString,
} from './optional-input.js';

describe('isBlankInput', () => {
  it.each([undefined, null, '', ' ', '\n\t  '])('treats %o as blank', (value) => {
    expect(isBlankInput(value)).toBe(true);
  });

  it.each([0, false, 'x', ' x ', [], {}, [''], NaN])('treats %o as present', (value) => {
    // 0 and false are load-bearing: a numeric/boolean field must be able to
    // carry a falsy value without being read as "not supplied".
    expect(isBlankInput(value)).toBe(false);
  });
});

describe('readOptional', () => {
  it('returns undefined when the key is blank', () => {
    expect(readOptional({ a: '' }, 'a')).toBeUndefined();
    expect(readOptional({ a: null }, 'a')).toBeUndefined();
    expect(readOptional({}, 'a')).toBeUndefined();
  });

  it('returns a present value verbatim, untrimmed', () => {
    expect(readOptional({ a: ' /tmp/x ' }, 'a')).toBe(' /tmp/x ');
    expect(readOptional({ a: 0 }, 'a')).toBe(0);
    expect(readOptional({ a: false }, 'a')).toBe(false);
  });

  it('skips blank keys in order and returns the first real one', () => {
    expect(readOptional({ a: '', b: 'real' }, 'a', 'b')).toBe('real');
    expect(readOptional({ a: 'first', b: 'second' }, 'a', 'b')).toBe('first');
    expect(readOptional({ a: '', b: null }, 'a', 'b')).toBeUndefined();
  });
});

describe('readOptionalString', () => {
  it('collapses blank to undefined', () => {
    expect(readOptionalString({ cwd: '  ' }, 'cwd')).toBeUndefined();
  });

  it('throws on a wrong type, naming the field and the value', () => {
    expect(() => readOptionalString({ cwd: 42 }, 'cwd')).toThrow(
      /Agent tool cwd must be a string, got: 42/,
    );
  });

  it('reports errors under an explicit label', () => {
    expect(() => readOptionalString({ subagent_type: 7 }, 'subagent_type', 'agent_type')).toThrow(
      /agent_type must be a string/,
    );
  });
});

describe('readOptionalAliasString', () => {
  it('falls through blanks to the alias', () => {
    expect(readOptionalAliasString({ a: '', b: 'x' }, ['a', 'b'], 'a')).toBe('x');
  });

  it('throws under the canonical label when the winning value is mistyped', () => {
    expect(() => readOptionalAliasString({ a: '', b: 7 }, ['a', 'b'], 'a')).toThrow(
      /Agent tool a must be a string, got: 7/,
    );
  });
});

describe('readOptionalNumber', () => {
  it('collapses blank to undefined so the caller default applies', () => {
    expect(readOptionalNumber({ max_turns: null }, 'max_turns')).toBeUndefined();
    expect(readOptionalNumber({ max_turns: '' }, 'max_turns')).toBeUndefined();
  });

  it('preserves 0 (a falsy but meaningful value)', () => {
    expect(readOptionalNumber({ max_turns: 0 }, 'max_turns')).toBe(0);
  });

  it('refuses to coerce a numeric string', () => {
    expect(() => readOptionalNumber({ max_turns: '10' }, 'max_turns')).toThrow(
      /max_turns must be a number, got: "10"/,
    );
  });
});
