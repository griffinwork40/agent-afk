import { describe, it, expect, vi } from 'vitest';
import { parseJsonlLines } from '../../src/utils/jsonl.js';

describe('parseJsonlLines', () => {
  // ---------------------------------------------------------------------------
  // 1. Basic parsing
  // ---------------------------------------------------------------------------
  describe('basic parsing', () => {
    it('parses a single JSON line', () => {
      expect(parseJsonlLines('{"a":1}')).toEqual([{ a: 1 }]);
    });

    it('parses multiple JSON lines', () => {
      expect(parseJsonlLines('{"a":1}\n{"b":2}\n{"c":3}')).toEqual([
        { a: 1 },
        { b: 2 },
        { c: 3 },
      ]);
    });

    it('skips blank lines', () => {
      expect(parseJsonlLines('\n{"a":1}\n\n{"b":2}\n')).toEqual([
        { a: 1 },
        { b: 2 },
      ]);
    });

    it('handles trailing newline gracefully', () => {
      expect(parseJsonlLines('{"a":1}\n')).toEqual([{ a: 1 }]);
    });

    it('returns empty array for empty string', () => {
      expect(parseJsonlLines('')).toEqual([]);
    });

    it('returns empty array for whitespace-only input', () => {
      expect(parseJsonlLines('   \n  \n')).toEqual([]);
    });

    it('parses primitive JSON values', () => {
      expect(parseJsonlLines('1\n"hello"\ntrue\nnull')).toEqual([1, 'hello', true, null]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Guard filtering
  // ---------------------------------------------------------------------------
  describe('guard filtering', () => {
    const isObj = (x: unknown): x is { a: number } =>
      x !== null && typeof x === 'object' && 'a' in (x as object);

    it('keeps only values that pass the guard', () => {
      const result = parseJsonlLines<{ a: number }>('{"a":1}\n{"b":2}\n{"a":3}', {
        guard: isObj,
      });
      expect(result).toEqual([{ a: 1 }, { a: 3 }]);
    });

    it('returns empty array when no values pass the guard', () => {
      const result = parseJsonlLines<{ a: number }>('{"b":1}\n{"c":2}', { guard: isObj });
      expect(result).toEqual([]);
    });

    it('guard rejections do NOT trigger onParseError', () => {
      const onParseError = vi.fn();
      // '{"b":2}' is valid JSON but rejected by the guard — onParseError must not fire
      parseJsonlLines<{ a: number }>('{"a":1}\n{"b":2}', {
        guard: isObj,
        onParseError,
      });
      expect(onParseError).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. onParseError callback
  // ---------------------------------------------------------------------------
  describe('onParseError callback', () => {
    it('calls onParseError for each malformed line', () => {
      const errors: string[] = [];
      parseJsonlLines('{"a":1}\nnot-json\nalso-bad', {
        onParseError: (line) => errors.push(line),
      });
      expect(errors).toEqual(['not-json', 'also-bad']);
    });

    it('does not call onParseError for blank lines', () => {
      const onParseError = vi.fn();
      parseJsonlLines('\n\n{"a":1}\n\n', { onParseError });
      expect(onParseError).not.toHaveBeenCalled();
    });

    it('skips malformed lines and continues parsing valid ones', () => {
      const result = parseJsonlLines('{"a":1}\nbad\n{"b":2}');
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('passes the trimmed line to onParseError', () => {
      const errors: string[] = [];
      parseJsonlLines('  bad-json  ', { onParseError: (l) => errors.push(l) });
      expect(errors).toEqual(['bad-json']);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Combined guard + onParseError
  // ---------------------------------------------------------------------------
  describe('combined guard + onParseError', () => {
    it('fires onParseError only for JSON failures; guard silently drops valid-but-rejected values', () => {
      // Input: 3 lines
      //   {"a":1}  → valid JSON, passes guard  → included in result
      //   not-json → JSON.parse failure         → triggers onParseError
      //   null     → valid JSON, fails guard    → silently dropped (NO onParseError)
      const onParseError = vi.fn();
      const result = parseJsonlLines<{ a: number }>('{"a":1}\nnot-json\nnull', {
        guard: (x): x is { a: number } =>
          x !== null && typeof x === 'object' && 'a' in (x as object),
        onParseError,
      });

      // onParseError called exactly once — for "not-json" only
      expect(onParseError).toHaveBeenCalledTimes(1);
      expect(onParseError).toHaveBeenCalledWith('not-json');

      // null passed JSON.parse but was silently dropped by the guard
      expect(result).toEqual([{ a: 1 }]);
    });

    it('handles a mix of malformed lines, guard-rejected values, and passing values', () => {
      const errors: string[] = [];
      const guard = (x: unknown): x is { id: number } =>
        typeof x === 'object' && x !== null && typeof (x as { id: unknown }).id === 'number';

      const result = parseJsonlLines<{ id: number }>(
        '{"id":1}\nnot-json\n{"name":"no-id"}\n{"id":2}\n[bad\n{"id":3}',
        { guard, onParseError: (l) => errors.push(l) },
      );

      expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      // "not-json" and "[bad" are JSON parse failures; {"name":"no-id"} is guard-rejected silently
      expect(errors).toEqual(['not-json', '[bad']);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Guard rejections do NOT trigger onParseError (explicit spec requirement)
  // ---------------------------------------------------------------------------
  describe('guard rejection vs parse error separation', () => {
    it('distinguishes between parse errors (trigger callback) and guard rejections (silent)', () => {
      const parseErrors: string[] = [];
      const guardRejections: unknown[] = [];

      // Guard accepts only objects with a numeric `id` field.
      // All non-matching but valid JSON values (including null, strings, objects
      // without `id`) are guard-rejected and must NOT appear in parseErrors.
      const wrappedGuard = (x: unknown): x is { id: number } => {
        const passes = typeof x === 'object' && x !== null && typeof (x as { id: unknown }).id === 'number';
        if (!passes) guardRejections.push(x);
        return passes;
      };

      const result = parseJsonlLines<{ id: number }>(
        '{"id":1}\nbad-json\nnull\n{"name":"no-id"}\n{"id":2}',
        {
          guard: wrappedGuard,
          onParseError: (l) => parseErrors.push(l),
        },
      );

      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
      // Only "bad-json" caused a parse error
      expect(parseErrors).toEqual(['bad-json']);
      // null and {"name":"no-id"} were guard-rejected (valid JSON, not parse errors)
      expect(guardRejections).toEqual([null, { name: 'no-id' }]);
      // onParseError was NOT called for the guard-rejected values
      expect(parseErrors).not.toContain('null');
      expect(parseErrors).not.toContain('{"name":"no-id"}');
    });
  });
});
