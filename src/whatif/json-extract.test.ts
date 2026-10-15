/**
 * Tests for json-extract.ts
 */

import { describe, it, expect } from 'vitest';
import { extractJson, extractJsonAs } from './json-extract.js';
import { z } from 'zod';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a bare JSON array', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('extracts JSON from prose', () => {
    expect(extractJson('Here is the result:\n{"x":"y"}\nDone.')).toEqual({ x: 'y' });
  });

  it('extracts JSON from ```json fences', () => {
    const text = '```json\n{"foo":"bar"}\n```';
    expect(extractJson(text)).toEqual({ foo: 'bar' });
  });

  it('extracts JSON from plain ``` fences', () => {
    const text = '```\n[1,2]\n```';
    expect(extractJson(text)).toEqual([1, 2]);
  });

  it('handles nested objects', () => {
    expect(extractJson('{"a":{"b":{"c":42}}}')).toEqual({ a: { b: { c: 42 } } });
  });

  it('returns undefined for no JSON', () => {
    expect(extractJson('no json here at all')).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    // This is not balanced and can't be parsed.
    expect(extractJson('{unclosed')).toBeUndefined();
  });

  it('handles string with escaped quotes', () => {
    expect(extractJson('{"key":"val\\"ue"}')).toEqual({ key: 'val"ue' });
  });

  it('picks the first object when multiple exist', () => {
    expect(extractJson('{"a":1} {"b":2}')).toEqual({ a: 1 });
  });
});

describe('extractJsonAs', () => {
  const schema = z.object({ n: z.number() });

  it('validates and returns typed result', () => {
    expect(extractJsonAs('{"n":42}', schema)).toEqual({ n: 42 });
  });

  it('throws when no JSON found', () => {
    expect(() => extractJsonAs('no json', schema)).toThrow('no JSON');
  });

  it('throws when schema validation fails', () => {
    expect(() => extractJsonAs('{"n":"not-a-number"}', schema)).toThrow('schema validation failed');
  });
});
