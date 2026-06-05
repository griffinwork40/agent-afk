/**
 * Tests for extractStructuredOutput.
 *
 * Pins the documented contract: returns a SINGLE value. Multiple top-level
 * JSON values are NOT aggregated — later values shadow earlier ones. The
 * "multiple bare objects" case is the documented gap that motivated this
 * test file; the test below pins it explicitly so any future change to that
 * behavior is a deliberate decision.
 */

import { describe, it, expect } from 'vitest';
import { extractStructuredOutput } from './output-extractor.js';

describe('extractStructuredOutput', () => {
  describe('fenced JSON blocks', () => {
    it('parses a single ```json fenced object', () => {
      const content = 'Some prose.\n\n```json\n{"a": 1, "b": "two"}\n```';
      expect(extractStructuredOutput(content)).toEqual({ a: 1, b: 'two' });
    });

    it('parses a single ```json fenced array', () => {
      const content = 'verdicts:\n```json\n[{"id": 1}, {"id": 2}]\n```';
      expect(extractStructuredOutput(content)).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('parses an unlabeled ``` fence', () => {
      const content = '```\n{"raw": true}\n```';
      expect(extractStructuredOutput(content)).toEqual({ raw: true });
    });

    it('parses a fenced JSON primitive', () => {
      expect(extractStructuredOutput('```json\n42\n```')).toBe(42);
      expect(extractStructuredOutput('```json\n"hello"\n```')).toBe('hello');
      expect(extractStructuredOutput('```json\ntrue\n```')).toBe(true);
      expect(extractStructuredOutput('```json\nnull\n```')).toBeNull();
    });

    it('returns the LAST fenced block when multiple are present', () => {
      const content = [
        '```json',
        '{"first": true}',
        '```',
        '',
        'and the final answer:',
        '',
        '```json',
        '{"final": true}',
        '```',
      ].join('\n');
      expect(extractStructuredOutput(content)).toEqual({ final: true });
    });

    it('handles a multiline fenced object with whitespace', () => {
      const content = '```json\n{\n  "nested": {\n    "k": [1, 2, 3]\n  }\n}\n```';
      expect(extractStructuredOutput(content)).toEqual({ nested: { k: [1, 2, 3] } });
    });

    it('falls back to balanced-braces when the last fence is malformed JSON', () => {
      const content = [
        'preamble',
        '```json',
        '{ this is not json }',
        '```',
        '',
        'actual answer: {"ok": true}',
      ].join('\n');
      expect(extractStructuredOutput(content)).toEqual({ ok: true });
    });
  });

  describe('balanced-braces fallback (no fence)', () => {
    it('parses a bare object in prose', () => {
      const content = 'Here is the result: {"value": 42}';
      expect(extractStructuredOutput(content)).toEqual({ value: 42 });
    });

    it('parses the LAST bare object when multiple are present (documented gap)', () => {
      // Documents the contract: multi-object output collapses to the last
      // balanced object. Callers wanting array semantics must instruct the
      // sub-agent to emit a single fenced JSON array instead.
      const content = '{"first": 1}\n\nfollowed by\n\n{"second": 2}';
      expect(extractStructuredOutput(content)).toEqual({ second: 2 });
    });

    it('skips text containing only a stray brace', () => {
      const content = 'a closing brace } in prose, then {"real": "json"}';
      expect(extractStructuredOutput(content)).toEqual({ real: 'json' });
    });

    it('handles nested braces correctly (depth tracking)', () => {
      const content = 'note: {"outer": {"inner": {"deep": true}}}';
      expect(extractStructuredOutput(content)).toEqual({
        outer: { inner: { deep: true } },
      });
    });

    it('does not match braces inside JSON string literals', () => {
      const content = '{"text": "has } and { inside", "ok": true}';
      expect(extractStructuredOutput(content)).toEqual({
        text: 'has } and { inside',
        ok: true,
      });
    });
  });

  describe('non-parseable input', () => {
    it('returns undefined for empty content', () => {
      expect(extractStructuredOutput('')).toBeUndefined();
    });

    it('returns undefined for prose with no JSON', () => {
      expect(extractStructuredOutput('just plain text, no json here.')).toBeUndefined();
    });

    it('returns undefined when fences contain only invalid JSON and no bare object exists', () => {
      const content = '```json\nnot really json\n```';
      expect(extractStructuredOutput(content)).toBeUndefined();
    });

    it('returns undefined for an empty fenced block', () => {
      expect(extractStructuredOutput('```json\n\n```')).toBeUndefined();
    });
  });
});
