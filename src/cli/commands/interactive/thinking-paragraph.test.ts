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
 *   (h) Perf bound — content (issue #23): on a 100 KB buffer the visible body is
 *       the exact most-recent prose suffix and the footer totals every dropped
 *       char (head-slice included). Byte-identical wrap to the old full-buffer
 *       algorithm is deliberately NOT asserted — greedy-wrap phase makes it
 *       unachievable with bounded work; see the test body.
 *   (i) Perf bound — cost: the visible body is independent of everything before
 *       the tail budget — the observable proof that the O(N) normalize+wrap only
 *       ever touches a bounded tail, not the full buffer.
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

/**
 * Deterministic single-spaced prose with VARIED word lengths (1–11 chars).
 * Single spacing (no whitespace runs, no leading/trailing space) is what makes
 * the footer-accounting assertions in (h) exact. Seeded LCG → reproducible.
 */
function buildProse(targetLen: number): string {
  let seed = 0x2545f4914f6cdd1d % 0x7fffffff;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const words: string[] = [];
  let total = 0;
  while (total < targetLen) {
    const len = 1 + Math.floor(rand() * 11);
    const w = String.fromCharCode(97 + Math.floor(rand() * 26)).repeat(len);
    words.push(w);
    total += w.length + 1;
  }
  return words.join(' ');
}

/** Body lines = everything between the header and the optional footer. */
function bodyOf(out: string): string[] {
  const lines = stripAnsi(out).split('\n').slice(1);
  if (lines.length && /chars earlier$/.test(lines[lines.length - 1] ?? '')) lines.pop();
  return lines;
}

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

  it('(h) 100 KB buffer: visible body is the exact most-recent prose + footer totals all dropped chars', () => {
    // Acceptance (issue #23). Byte-identical equality with the old full-buffer
    // wrap is NOT a sound invariant: greedy word-wrap line breaks depend on the
    // start offset, so a bounded tail-slice can land the *top* visible line a
    // word or two off the full wrap, and no finite tail budget fixes every
    // input (re-sync took 62 wrapped lines at cols:120 for this very buffer).
    // What IS guaranteed — and is what users actually care about — is asserted
    // here: the rendered reasoning is the true most-recent suffix of the CoT
    // (nothing fabricated or skipped), and the `⋯ +N` footer accounts for every
    // earlier char, including the head sliced off before wrapping (issue #23's
    // 4th acceptance bullet). Both hold exactly for single-spaced prose at any
    // width, independent of wrap phase.
    const buffer = buildProse(100 * 1024);
    expect(buffer.length).toBeGreaterThan(100 * 1024 - 12);
    for (const cols of [42, 80, 120, 200]) {
      const plain = stripAnsi(formatThinkingParagraph(buffer, { cols, maxLines: 5 })).split('\n');
      const footerMatch = (plain[plain.length - 1] ?? '').match(/\+(\d+) chars earlier$/);
      expect(footerMatch, `cols=${cols} renders a truncation footer`).not.toBeNull();
      const droppedChars = Number(footerMatch![1]);
      const body = plain.slice(1, -1).map((l) => l.replace(/^ {2}/, ''));
      expect(body, `cols=${cols} caps at maxLines`).toHaveLength(5);

      // De-wrapping the body (join lines with the single space wrap-ansi trimmed
      // at each break) reconstructs an exact, contiguous suffix of the buffer.
      const visibleProse = body.join(' ');
      expect(buffer.endsWith(visibleProse), `cols=${cols} body is most-recent suffix`).toBe(true);

      // Everything before the visible region was dropped. For single-spaced
      // prose that is `len - visibleProse - 1` (the 1 = the space separating the
      // dropped region from the visible region). This equals what the
      // un-truncated algorithm would report for the same visible region, and
      // would be off by ~the whole buffer if the pre-slice head weren't folded in.
      expect(droppedChars, `cols=${cols} footer totals all dropped chars`).toBe(
        buffer.length - visibleProse.length - 1,
      );
    }
  });

  it('(i) visible body is independent of buffer length before the tail budget (O(maxLines·bodyWidth) bound)', () => {
    // The expensive normalize+wrap must only ever see a bounded tail. Two
    // buffers that share an identical suffix longer than the tail budget
    // (maxLines·bodyWidth·4 = 5·40·4 = 800 at cols:42) must produce the SAME
    // visible body regardless of how much precedes it — the observable proof
    // that work does not scale with total buffer length. Footers differ (they
    // count the dropped head), so only the body is compared.
    const sharedSuffix = buildProse(4000); // ≫ 800-char tail budget
    const opts = { cols: 42, maxLines: 5 };
    const small = formatThinkingParagraph('lead in. ' + sharedSuffix, opts);
    const huge = formatThinkingParagraph(buildProse(200 * 1024) + ' ' + sharedSuffix, opts);
    expect(bodyOf(huge)).toEqual(bodyOf(small));
    expect(bodyOf(small)).toHaveLength(5);
  });
});
