/**
 * Tests for the bash result display formatter.
 *
 * Pinned shapes:
 * - Single-line JSON object → `{key1, key2, …}` summary.
 * - Single-line JSON array → `[N items]` summary.
 * - Plain text → `null` (caller falls through to lineCount / preview).
 *
 * The bug this formatter fixes: `gh pr view --json` output rendering as
 * a truncated raw-JSON slice `{"additions":1016,"baseRefName":"main","b…`
 * in the tool lane instead of a readable summary.
 */

import { describe, it, expect } from 'vitest';
import { formatBashDisplay } from './bash-renderer.js';

describe('formatBashDisplay — JSON object outputs', () => {
  it('summarizes the gh pr view --json shape', () => {
    const raw =
      '{"additions":1016,"baseRefName":"main","body":"## Summary\\n…","title":"Foo"}';
    expect(formatBashDisplay(raw)).toBe('{additions, baseRefName, body, title}');
  });

  it('elides keys beyond MAX_KEYS_SHOWN with a trailing …', () => {
    const raw = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}';
    expect(formatBashDisplay(raw)).toBe('{a, b, c, d, …}');
  });

  it('renders single-key object without elision', () => {
    expect(formatBashDisplay('{"name":"foo"}')).toBe('{name}');
  });

  it('renders empty object', () => {
    expect(formatBashDisplay('{}')).toBe('{empty object}');
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(formatBashDisplay('  \n{"a":1,"b":2}\n  ')).toBe('{a, b}');
  });
});

describe('formatBashDisplay — JSON array outputs', () => {
  it('summarizes multi-element array as [N items]', () => {
    const raw = '[{"id":1},{"id":2},{"id":3}]';
    expect(formatBashDisplay(raw)).toBe('[3 items]');
  });

  it('singular for length-1 array', () => {
    expect(formatBashDisplay('[{"id":1}]')).toBe('[1 item]');
  });

  it('empty array', () => {
    expect(formatBashDisplay('[]')).toBe('[empty array]');
  });
});

describe('formatBashDisplay — fail-open on non-JSON', () => {
  it('returns null for plain text', () => {
    expect(formatBashDisplay('hello world')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(formatBashDisplay('')).toBeNull();
    expect(formatBashDisplay('   \n  ')).toBeNull();
  });

  it('returns null for shell output that starts with { but is not JSON', () => {
    // Brace expansion echoed back: `echo {a,b,c}` → `a b c`, but if quoted,
    // could start with `{`. Conservative: structural endpoints must match
    // and JSON.parse must succeed.
    expect(formatBashDisplay('{a,b,c}')).toBeNull();
    expect(formatBashDisplay('{ not json')).toBeNull();
  });

  it('returns null for unterminated JSON (matches the truncation symptom)', () => {
    // If the handler somehow delivered already-truncated JSON, the formatter
    // should not produce a misleading summary from a half-parse.
    expect(formatBashDisplay('{"additions":1016,"baseRefName":"main","b')).toBeNull();
  });

  it('returns null for JSON primitives (string / number / boolean)', () => {
    // Valid JSON but no structured shape to summarize. Plain `"hello"` or
    // `42` reads better as itself via the lineCount/preview path.
    expect(formatBashDisplay('"hello"')).toBeNull();
    expect(formatBashDisplay('42')).toBeNull();
    expect(formatBashDisplay('true')).toBeNull();
    expect(formatBashDisplay('null')).toBeNull();
  });

  it('returns null for multi-line plain text output', () => {
    // The common case: build logs, command output, etc. lineCount path
    // renders these as "N lines".
    const raw = 'line one\nline two\nline three';
    expect(formatBashDisplay(raw)).toBeNull();
  });
});

describe('formatBashDisplay — display caps', () => {
  it('caps very wide key lists at the display char limit', () => {
    // Long keys: ensure we don't blow past 80 chars even before elision.
    const longKey = 'k'.repeat(40);
    const raw = `{"${longKey}":1,"${longKey}2":2}`;
    const out = formatBashDisplay(raw);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(80);
    expect(out!.endsWith('…')).toBe(true);
  });
});
