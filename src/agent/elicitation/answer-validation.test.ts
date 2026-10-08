/**
 * Unit tests for src/agent/elicitation/answer-validation.ts
 *
 * Covers:
 *   - validateTextAnswer: minLength, maxLength, no constraints, exact boundary
 *   - validateNumberAnswer: NaN, min, max, no constraints, exact boundary
 */

import { describe, it, expect } from 'vitest';
import { validateTextAnswer, validateNumberAnswer } from './answer-validation.js';

// ---------------------------------------------------------------------------
// validateTextAnswer
// ---------------------------------------------------------------------------

describe('validateTextAnswer', () => {
  it('returns ok:true with value when no constraints are set', () => {
    const result = validateTextAnswer('hello', {});
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('returns ok:true when input length equals minLength exactly', () => {
    const result = validateTextAnswer('abc', { minLength: 3 });
    expect(result).toEqual({ ok: true, value: 'abc' });
  });

  it('returns ok:false when input is shorter than minLength', () => {
    const result = validateTextAnswer('ab', { minLength: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at least 3/i);
  });

  it('returns ok:true when input length equals maxLength exactly', () => {
    const result = validateTextAnswer('abcde', { maxLength: 5 });
    expect(result).toEqual({ ok: true, value: 'abcde' });
  });

  it('returns ok:false when input exceeds maxLength', () => {
    const result = validateTextAnswer('abcdef', { maxLength: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at most 5/i);
  });

  it('returns ok:true when input is within minLength and maxLength', () => {
    const result = validateTextAnswer('hello', { minLength: 2, maxLength: 10 });
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('returns ok:false when input is below minLength (both constraints)', () => {
    const result = validateTextAnswer('h', { minLength: 2, maxLength: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at least 2/i);
  });

  it('returns ok:false when input exceeds maxLength (both constraints)', () => {
    const result = validateTextAnswer('hello world!', { minLength: 2, maxLength: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at most 10/i);
  });

  it('counts emoji as one character (Unicode code-point length)', () => {
    // '😀' is one code point but two UTF-16 code units (.length === 2)
    const result = validateTextAnswer('😀', { minLength: 1, maxLength: 1 });
    expect(result).toEqual({ ok: true, value: '😀' });
  });

  it('rejects input whose code-point length exceeds maxLength even with multi-code-unit chars', () => {
    // '😀😀' = 2 code points, raw .length === 4 — maxLength: 1 must reject it
    const result = validateTextAnswer('😀😀', { maxLength: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at most 1/i);
  });
});

// ---------------------------------------------------------------------------
// validateNumberAnswer
// ---------------------------------------------------------------------------

describe('validateNumberAnswer', () => {
  it('returns ok:true with numeric value when no constraints are set', () => {
    const result = validateNumberAnswer('42', {});
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('returns ok:false for non-numeric input', () => {
    const result = validateNumberAnswer('abc', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/valid number/i);
  });

  it('returns ok:false for NaN input', () => {
    const result = validateNumberAnswer('NaN', {});
    expect(result.ok).toBe(false);
  });

  it('returns ok:true when value equals min exactly', () => {
    const result = validateNumberAnswer('5', { min: 5 });
    expect(result).toEqual({ ok: true, value: 5 });
  });

  it('returns ok:false when value is below min', () => {
    const result = validateNumberAnswer('4', { min: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/≥ 5/);
  });

  it('returns ok:true when value equals max exactly', () => {
    const result = validateNumberAnswer('10', { max: 10 });
    expect(result).toEqual({ ok: true, value: 10 });
  });

  it('returns ok:false when value exceeds max', () => {
    const result = validateNumberAnswer('11', { max: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/≤ 10/);
  });

  it('returns ok:true when value is within min and max', () => {
    const result = validateNumberAnswer('7', { min: 5, max: 10 });
    expect(result).toEqual({ ok: true, value: 7 });
  });

  it('handles float input', () => {
    const result = validateNumberAnswer('3.14', { min: 1, max: 10 });
    expect(result).toEqual({ ok: true, value: 3.14 });
  });

  it('returns ok:false for Infinity', () => {
    const result = validateNumberAnswer('Infinity', {});
    expect(result.ok).toBe(false);
  });
});
