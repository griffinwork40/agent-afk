/**
 * Tests for {@link formatThinkingParagraph} — the wrapped-paragraph
 * formatter that replaced the trailing-80-codepoint single-line preview at
 * `setComposedOverlay` in stream-renderer-orchestrator.ts.
 *
 * Cases covered:
 *   (a) Empty / whitespace buffer → empty string (caller skips the layer).
 *   (b) Short single-paragraph buffer → header + single body line, no footer.
 *   (c) Long buffer → header + N body lines (cap), `⋯ +N chars earlier` footer.
 *   (d) Body width respects 2-col indent (terminal cols minus INDENT.length).
 *   (e) MIN_BODY_WIDTH floor on narrow terminals (no per-glyph breaks).
 *   (f) Internal whitespace (newlines, runs of spaces) collapsed to single spaces.
 *   (g) Custom `maxLines` honored.
 *
 * Assertions look at the ANSI-stripped string so the structure (line count,
 * presence of header/footer text) is testable without coupling to chalk's
 * exact escape sequences.
 *
 * @module cli/commands/interactive/thinking-paragraph.test
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../../display.js';
import { formatThinkingParagraph } from './thinking-paragraph.js';

describe('formatThinkingParagraph', () => {
  it('(a) returns empty string for an empty buffer', () => {
    expect(formatThinkingParagraph('', { cols: 80 })).toBe('');
    expect(formatThinkingParagraph('   ', { cols: 80 })).toBe('');
    expect(formatThinkingParagraph('\n\n\t  ', { cols: 80 })).toBe('');
  });

  it('(b) short buffer renders as header + single body line with no truncation footer', () => {
    const out = formatThinkingParagraph('Let me think about this briefly.', { cols: 80 });
    const plain = stripAnsi(out);
    const lines = plain.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('  ◆ thinking');
    expect(lines[1]).toBe('  Let me think about this briefly.');
    expect(plain).not.toContain('chars earlier');
  });

  it('(c) long buffer caps body lines and appends `⋯ +N chars earlier` footer', () => {
    // 120 short words → many wrapped lines at 40-col body width.
    const buffer = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const out = formatThinkingParagraph(buffer, { cols: 42, maxLines: 5 });
    const plain = stripAnsi(out);
    const lines = plain.split('\n');
    // header + 5 body + footer = 7 lines exactly.
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('  ◆ thinking');
    expect(lines[6]).toMatch(/^ {2}⋯ \+\d+ chars earlier$/);
    // First body line is mid-stream — last 5 wrapped lines kept.
    expect(lines[1]?.startsWith('  ')).toBe(true);
  });

  it('(d) wraps body to (cols - INDENT) and indents every line by 2 cols', () => {
    // Build a buffer long enough to wrap at least twice at 30-col width.
    const buffer = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const out = formatThinkingParagraph(buffer, { cols: 30, maxLines: 10 });
    const plain = stripAnsi(out);
    const lines = plain.split('\n');
    // At least header + 2 body lines.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // Every line begins with the 2-col indent.
    for (const line of lines) expect(line.startsWith('  ')).toBe(true);
    // Body lines (skip the header) honor the body width (cols - 2 = 28).
    // wrap-ansi with wordWrap: true, hard: false may slightly exceed for
    // unbreakable tokens, but our `wordN` tokens are short so the cap holds.
    for (const line of lines.slice(1)) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it('(e) MIN_BODY_WIDTH floor on narrow terminals — no per-glyph breaks', () => {
    // cols=10 → bodyWidth = max(16, 10 - 2) = 16.
    const buffer = 'one two three four five six seven eight nine ten eleven twelve';
    const out = formatThinkingParagraph(buffer, { cols: 10, maxLines: 10 });
    const plain = stripAnsi(out);
    const bodyLines = plain.split('\n').slice(1).filter((l) => !l.includes('chars earlier'));
    // Each body line is roughly 16-18 visible cols (indent + body), never 1
    // glyph wide. Floor at, say, 3 chars of content per line (indent + 1).
    for (const line of bodyLines) {
      expect(line.length).toBeGreaterThan(3);
    }
  });

  it('(f) collapses internal whitespace (runs of newlines / spaces) to single spaces', () => {
    const buffer = 'First clause.\n\n\nSecond    clause   with    spaces.';
    const out = formatThinkingParagraph(buffer, { cols: 80 });
    const plain = stripAnsi(out);
    expect(plain).toContain('First clause. Second clause with spaces.');
    // No raw newlines other than the structural ones between overlay lines.
    expect(plain.split('\n').every((l) => !l.includes('\n'))).toBe(true);
  });

  it('(g) honors a custom maxLines cap', () => {
    const buffer = Array.from({ length: 80 }, (_, i) => `tok${i}`).join(' ');
    const out2 = formatThinkingParagraph(buffer, { cols: 30, maxLines: 2 });
    const plain2 = stripAnsi(out2);
    const lines2 = plain2.split('\n');
    // header + 2 body + footer = 4 lines
    expect(lines2).toHaveLength(4);
    expect(lines2[3]).toMatch(/^ {2}⋯ \+\d+ chars earlier$/);
  });

  it('header uses the same `◆` glyph as the collapsed summary line for visual identity', () => {
    // Mirrors `ThinkingLane.collapse()` which emits `◆ thought for ...`.
    const out = formatThinkingParagraph('anything', { cols: 80 });
    const plain = stripAnsi(out);
    expect(plain.split('\n')[0]).toContain('◆ thinking');
  });
});
