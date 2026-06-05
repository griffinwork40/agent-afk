/**
 * sanitize.test.ts — Unit tests for sanitizeSchemaString
 *
 * Covers:
 *   - Identity (ASCII, Unicode preserved)
 *   - 7-bit CSI stripping (the canonical ANSI_RE behaviour)
 *   - Extended trust-boundary coverage: OSC+BEL, OSC+ST, C1 CSI (\x9B), C1 single bytes
 *   - Truncation semantics (strip-first, then clamp)
 *   - Edge cases: empty string, only-ANSI input, maxLen=0, custom maxLen
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSchemaString } from './sanitize.js';

// ─── Identity / preservation ──────────────────────────────────────────────────

describe('sanitizeSchemaString — identity and Unicode preservation', () => {
  it('passes plain ASCII unchanged', () => {
    expect(sanitizeSchemaString('hello world')).toBe('hello world');
  });

  it('preserves emoji', () => {
    expect(sanitizeSchemaString('🌍')).toBe('🌍');
  });

  it('preserves CJK characters', () => {
    expect(sanitizeSchemaString('こんにちは')).toBe('こんにちは');
  });

  it('preserves accented Latin', () => {
    expect(sanitizeSchemaString('café')).toBe('café');
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeSchemaString('')).toBe('');
  });
});

// ─── 7-bit CSI stripping (existing behaviour) ─────────────────────────────────

describe('sanitizeSchemaString — 7-bit CSI sequences stripped', () => {
  it('strips SGR colour codes and preserves text', () => {
    expect(sanitizeSchemaString('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips CSI with multiple params (256-colour)', () => {
    expect(sanitizeSchemaString('\x1b[1;31;48;5;208mX\x1b[0m')).toBe('X');
  });

  it('strips bare ESC + @ final byte → empty string', () => {
    expect(sanitizeSchemaString('\x1b@')).toBe('');
  });

  it('strips bare ESC + H final byte → empty string', () => {
    expect(sanitizeSchemaString('\x1bH')).toBe('');
  });

  it('strips mid-string ANSI and preserves surrounding text', () => {
    expect(sanitizeSchemaString('hi\x1b[31mthere\x1b[0m')).toBe('hithere');
  });

  it('returns empty string when input is only ANSI escapes', () => {
    expect(sanitizeSchemaString('\x1b[31m\x1b[0m')).toBe('');
  });
});

// ─── Extended trust-boundary coverage: OSC, C1 CSI, C1 single bytes ──────────

describe('sanitizeSchemaString — OSC and C1 controls stripped', () => {
  it('strips OSC sequence terminated by BEL (\\x07)', () => {
    // e.g. terminal title-set: ESC ] 0 ; TITLE BEL
    expect(sanitizeSchemaString('\x1b]0;TITLE\x07hi')).toBe('hi');
  });

  it('strips OSC sequence terminated by ST (ESC \\\\)', () => {
    // String Terminator: ESC \
    expect(sanitizeSchemaString('\x1b]0;TITLE\x1b\\hi')).toBe('hi');
  });

  it('strips C1 CSI byte (\\x9B) with params', () => {
    // C1 CSI is a single byte equivalent of ESC [
    expect(sanitizeSchemaString('\x9b2KX')).toBe('X');
  });

  it('strips C1 single-byte control (\\x85 = NEL)', () => {
    expect(sanitizeSchemaString('\x85hi')).toBe('hi');
  });

  it('strips ESC byte left bare by OSC (no terminator) via the C1 single-byte rule', () => {
    // Unterminated OSC: ESC ] body — OSC arm needs BEL or ST to match, so this
    // falls through to the bare-ESC arm (ESC + ']' = bare ESC + final byte) and
    // is stripped via the existing ESC alternation.
    expect(sanitizeSchemaString('\x1b]hi')).toBe('hi');
  });
});

// ─── Truncation semantics ─────────────────────────────────────────────────────

describe('sanitizeSchemaString — truncation', () => {
  it('does not truncate a string at exactly the default maxLen (128)', () => {
    const s = 'a'.repeat(128);
    expect(sanitizeSchemaString(s)).toBe(s);
  });

  it('truncates a string one char over default maxLen and appends ellipsis', () => {
    // Implementation: stripped.slice(0, 128) + '…' → total JS length = 129
    const s = 'a'.repeat(129);
    const result = sanitizeSchemaString(s);
    expect(result).toBe('a'.repeat(128) + '…');
    expect(result.length).toBe(129);
  });

  it('strips ANSI first, then clamps — no truncation needed after stripping', () => {
    // 128 'a's + a bold-on escape: stripped length = 128, no truncation
    expect(sanitizeSchemaString('a'.repeat(128) + '\x1b[1m')).toBe('a'.repeat(128));
  });

  it('respects custom maxLen', () => {
    expect(sanitizeSchemaString('hello world', 5)).toBe('hello…');
  });

  it('maxLen=0: any non-empty string becomes "…"', () => {
    // slice(0, 0) = '' → '' + '…' = '…'
    expect(sanitizeSchemaString('x', 0)).toBe('…');
  });
});
