/**
 * Regression tests for CupFrameRenderer
 *
 * Core invariant: frame rendering uses CUP (absolute cursor positioning) for
 * ALL line transitions — never `\n`. This eliminates the "jumping" bug where
 * log-update's trailing `\n` at the DECSTBM bottom margin caused a scroll.
 *
 * Root cause (for reference):
 *   log-update appended a trailing `\n` to every frame (index.js:189).
 *   status-line.ts sets DECSTBM to (1, rows-1). TerminalCompositor.anchor()
 *   placed the cursor at rows-1 (the bottom margin) before the first repaint.
 *   The trailing `\n` at the bottom margin triggered a scroll, and the
 *   wrap-transition path triggered a second scroll — 2 accumulated scrolls
 *   per user session were perceived as the compositor "jumping upward."
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { CupFrameRenderer } from './cup-frame-renderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStream(isTTY = true, columns = 80, rows = 24): NodeJS.WriteStream {
  const s = new PassThrough() as unknown as NodeJS.WriteStream;
  s.isTTY = isTTY;
  s.columns = columns;
  s.rows = rows;
  return s;
}

function collectWrites(stream: NodeJS.WriteStream): () => string {
  const chunks: string[] = [];
  (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
  return () => chunks.join('');
}

// Parse all \n (literal newline) write events from captured stdout.
// We look for bare \n that is NOT part of an escape sequence, i.e. a
// "scrolling newline" that advances the terminal scroll region.
function countBareNewlines(output: string): number {
  // Strip all ESC sequences first, then count remaining \n characters.
  // ESC sequences: \x1b followed by any chars up to a letter.
  // This is a conservative approximation; sufficient for our test.
  const stripped = output.replace(/\x1b[^a-zA-Z]*[a-zA-Z]/g, '');
  return (stripped.match(/\n/g) ?? []).length;
}

// Count CUP escape sequences (\x1b[row;colH) in the output.
function countCups(output: string): number {
  return (output.match(/\x1b\[\d+;\d+H/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Core invariant: no bare \n when cursor is at or near the bottom margin
// ---------------------------------------------------------------------------

describe('CupFrameRenderer — no trailing-\\n scroll', () => {
  it('renders a single-line frame with CUP positioning, no bare \\n', () => {
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // targetBottomRow = 23 (rows-1), matching TerminalCompositor's repaint call.
    renderer.render('hello world', 23);

    const out = allWrites();
    // Must contain at least one CUP escape (line positioning).
    expect(countCups(out)).toBeGreaterThanOrEqual(1);
    // Must contain NO bare newlines — the key regression check.
    expect(countBareNewlines(out)).toBe(0);
    // Content must be present.
    expect(out).toContain('hello world');
  });

  it('renders a 2-line frame with CUP positioning, no bare \\n (the jumping-bug scenario)', () => {
    // This is the exact scenario from the jumping bug: user types a message
    // long enough to wrap to 2 lines (211 chars at 130-col → 2 visible lines).
    // With log-update, the wrap transition's trailing \n at the bottom margin
    // caused Scroll #2. Verify CupFrameRenderer uses CUP instead.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    const twoLineContent = 'first line\nsecond line';
    renderer.render(twoLineContent, 23);

    const out = allWrites();
    // 2-line frame: CupFrameRenderer positions each of 2 lines with CUP.
    // Minimum 2 CUP escapes expected (one per content line + possibly cursor park).
    expect(countCups(out)).toBeGreaterThanOrEqual(2);
    // Zero bare newlines — the key regression invariant.
    expect(countBareNewlines(out)).toBe(0);
    // Both lines present.
    expect(out).toContain('first line');
    expect(out).toContain('second line');
  });

  it('positions the last content line at targetBottomRow - 1 for a 2-line frame', () => {
    // Invariant: last content line at targetBottomRow - (lineCount - 1).
    // For lineCount=2, targetBottomRow=23: first line at row 22, second at row 23.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('line one\nline two', 23);

    const out = allWrites();
    // First line at row 22, second at row 23.
    expect(out).toContain('\x1b[22;1H');
    expect(out).toContain('\x1b[23;1H');
    // No row 24 (the status-line row — must never be written into).
    expect(out).not.toContain('\x1b[24;1H');
  });

  it('positions the single content line at targetBottomRow for a 1-line frame', () => {
    // For lineCount=1, targetBottomRow=23: the one line is at row 23.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('only line', 23);

    const out = allWrites();
    expect(out).toContain('\x1b[23;1H');
    expect(out).not.toContain('\x1b[24;1H');
  });

  it('does not write into the status-line row (rows) for any frame size', () => {
    // The status line owns rows=24 exclusively. TerminalCompositor passes
    // targetBottomRow = rows-1 = 23. Verify no CUP ever targets row 24.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // Large frame: 5 lines. Top row = 23 - 5 + 1 = 19.
    const content = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
    renderer.render(content, 23);

    const out = allWrites();
    // None of the CUP escapes may target row 24 (status line).
    expect(out).not.toContain('\x1b[24;1H');
    // Bottom content line must be at row 23.
    expect(out).toContain('\x1b[23;1H');
    // Top content line at row 19 (23 - 5 + 1).
    expect(out).toContain('\x1b[19;1H');
  });

  it('erases previous frame rows on second render, still no bare \\n', () => {
    // On the second render, the renderer erases the previous frame via CUP +
    // erase-line. Verify no \n appears during the erase pass or the new frame.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('first frame', 23);
    renderer.render('second frame line one\nsecond frame line two', 23);

    const out = allWrites();
    expect(countBareNewlines(out)).toBe(0);
    expect(out).toContain('second frame line one');
    expect(out).toContain('second frame line two');
  });

  it('uses CUP escapes for line transitions, not \\n (count comparison)', () => {
    // Definitive count-comparison test: for an N-line frame, there should be
    // ≥ N CUP escapes and 0 bare newlines.
    const N = 4;
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    const content = Array.from({ length: N }, (_, i) => `row ${i}`).join('\n');
    renderer.render(content, 23);

    const out = allWrites();
    const cups = countCups(out);
    const newlines = countBareNewlines(out);

    // At least N CUPs (one per content line, possibly more for cursor park).
    expect(cups).toBeGreaterThanOrEqual(N);
    // Zero bare newlines — the regression invariant.
    expect(newlines).toBe(0);
  });

  it('clear() erases all previously rendered rows without bare \\n', () => {
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('some content\nmore content', 23);

    // Capture only the clear() output.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.clear();
    const clearOut = chunks.join('');

    // clear() must not write bare newlines.
    expect(countBareNewlines(clearOut)).toBe(0);
    // clear() must include CUP escapes (to position for erase-line).
    expect(countCups(clearOut)).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Regression: clear() parks cursor at rows-1, not at previousTopRow.
  //
  // Without this invariant, commitAbove()'s subsequent stdout.write(text+'\n')
  // lands at a mid-screen row when the prior frame was multi-line. The
  // trailing '\n' never reaches the DECSTBM bottom margin, no scroll fires,
  // and the committed text sits stranded mid-viewport with empty scrollback
  // above it. See terminal-compositor.ts:737 commitAbove() for the consumer.
  // ---------------------------------------------------------------------------

  it('clear() parks cursor at rows-1 after a MULTI-LINE frame (regression)', () => {
    // The exact bug shape: an overlay frame spans many rows. previousTopRow
    // is mid-screen (e.g., row 4 for a 20-line frame in a 24-row terminal).
    // clear() must park at row 23 (rows-1), NOT at row 4.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // Render a 20-line frame. With targetBottomRow=23 and lineCount=20,
    // previousTopRow = 23 - 20 + 1 = 4.
    const content = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join('\n');
    renderer.render(content, 23);

    // Capture clear()'s output specifically.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.clear();
    void allWrites();
    const clearOut = chunks.join('');

    // The erase-line pass legitimately CUPs every row in [previousTopRow ..
    // previousTopRow + previousLineCount - 1] (here, rows 4..23) to position
    // ERASE_LINE — so we can't simply `expect.not.toContain('\x1b[4;1H')`.
    // The regression check is on the FINAL CUP in the output: the cursor-park
    // sequence emitted after the erase pass. Pre-fix it parked at row 4 (the
    // previousTopRow, mid-screen). Post-fix it parks at row 23 (rows-1, the
    // DECSTBM bottom anchor).
    const cupMatches = [...clearOut.matchAll(/\x1b\[(\d+);1H/g)];
    expect(cupMatches.length).toBeGreaterThan(0);
    const lastCup = cupMatches[cupMatches.length - 1];
    expect(lastCup?.[1]).toBe('23');
  });

  it('clear() parks cursor at rows-1 after a 1-LINE frame (no-op equivalence)', () => {
    // For a single-line idle frame, previousTopRow === rows-1 already, so
    // parking at rows-1 is equivalent to the old behavior. This test pins
    // that equivalence so future refactors don't drift.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('only line', 23);

    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.clear();
    void allWrites();
    const clearOut = chunks.join('');

    expect(clearOut).toContain('\x1b[23;1H');
    const cupMatches = [...clearOut.matchAll(/\x1b\[(\d+);1H/g)];
    const lastCup = cupMatches[cupMatches.length - 1];
    expect(lastCup?.[1]).toBe('23');
  });

  it('clear() parks cursor at row 1 on a 1-row terminal (clamp guard)', () => {
    // Pathological: rows=1 → rows-1 = 0 → clamped to row 1. Must NOT emit
    // \x1b[0;1H (invalid CUP target).
    const stream = makeMockStream(true, 80, 1);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('x', 0);

    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.clear();
    void allWrites();
    const clearOut = chunks.join('');

    expect(clearOut).toContain('\x1b[1;1H');
    expect(clearOut).not.toContain('\x1b[0;1H');
  });

  it('done() shows the cursor (\\x1b[?25h) without bare \\n', () => {
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('content', 23);

    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.done();
    const doneOut = chunks.join('');
    void allWrites();

    // done() must show the cursor.
    expect(doneOut).toContain('\x1b[?25h');
  });

  it('clamps to row 1 when targetBottomRow is 0 (pathological/resized-to-1-row)', () => {
    // rows=1 → targetBottomRow=0 → clamped to 1. Must not write \x1b[0;1H.
    const stream = makeMockStream(true, 80, 1);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('tiny terminal', 0);

    const out = allWrites();
    expect(out).toContain('\x1b[1;1H');
    expect(out).not.toContain('\x1b[0;1H');
  });

  it('no output written on non-TTY stream', () => {
    const stream = makeMockStream(false, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // On non-TTY: no synchronized output, no cursor escapes.
    // Content + CUPs are still written (stream.write is not gated on isTTY);
    // verify cursor escapes are absent.
    renderer.render('content', 23);

    const out = allWrites();
    // Synchronized output escapes must NOT appear on non-TTY.
    expect(out).not.toContain('\x1b[?2026h');
    expect(out).not.toContain('\x1b[?2026l');
    // Cursor hide must NOT appear on non-TTY.
    expect(out).not.toContain('\x1b[?25l');
    // Content must still be written (renderer doesn't gate content on isTTY).
    expect(out).toContain('content');
  });

  // -------------------------------------------------------------------------
  // H1 regression: frame-write failure restores cursor visibility.
  //
  // Scenario: CURSOR_HIDE is emitted as a separate write() call BEFORE the
  // frame content (so terminals without synchronized-output still see the
  // hide before flicker). If the subsequent frame-content write() throws
  // (TTY closed mid-render, EPIPE on a closed pipe), the cursor is left
  // invisible on the host terminal. The catch path must emit CURSOR_SHOW
  // best-effort so a partial teardown doesn't strand a phantom cursor.
  // -------------------------------------------------------------------------
  it('restores cursor visibility when the frame-content write throws', () => {
    // Mock stream: CURSOR_HIDE write succeeds, frame-content write throws,
    // recovery CURSOR_SHOW write succeeds. Capture which payloads were
    // attempted so we can assert on the recovery write.
    const writes: string[] = [];
    const stream = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (chunk: string): boolean => {
        writes.push(chunk);
        // Frame content is the long multi-escape payload; the brief
        // CURSOR_HIDE write is single-purpose. Distinguish by length.
        if (chunk.length > 10) {
          throw new Error('EPIPE');
        }
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const renderer = new CupFrameRenderer(stream);

    // Should not throw — catch block swallows the EPIPE and attempts recovery.
    expect(() => renderer.render('content that will fail', 23)).not.toThrow();

    // First write: CURSOR_HIDE.
    expect(writes[0]).toBe('\x1b[?25l');
    // Second write: frame content (threw).
    expect(writes[1]).toContain('content that will fail');
    // Third write: recovery CURSOR_SHOW emitted from the catch path.
    expect(writes[2]).toBe('\x1b[?25h');
  });

  it('does not attempt cursor restore on non-TTY when frame write throws', () => {
    // Non-TTY: CURSOR_HIDE is never emitted, so the recovery path must also
    // skip CURSOR_SHOW. Otherwise a non-TTY consumer would see a stray ANSI
    // escape in its captured output.
    const writes: string[] = [];
    const stream = {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: (chunk: string): boolean => {
        writes.push(chunk);
        throw new Error('EPIPE');
      },
    } as unknown as NodeJS.WriteStream;

    const renderer = new CupFrameRenderer(stream);
    expect(() => renderer.render('content', 23)).not.toThrow();

    // No write should contain CURSOR_SHOW (\x1b[?25h) on non-TTY.
    const allWrites = writes.join('');
    expect(allWrites).not.toContain('\x1b[?25h');
  });

  // -------------------------------------------------------------------------
  // Resize regression: resetGeometry() drops previous-frame coordinates so
  // the next render() after a SIGWINCH skips its stale erase pass.
  //
  // Pre-fix bug shape: terminal resized from 24 rows to 40. previousTopRow=23
  // and previousLineCount=1 were captured at the old geometry. The next
  // render() erases row 23 (correct for old geometry) and paints a single
  // line at the new bottom row 39 — leaving rows 24..38 as a blank stripe.
  // Or, on shrink (24→12), the erase loop CUPs row 23 which is now beyond
  // the terminal viewport; the terminal clamps that CUP and the pre-resize
  // frame content survives in scrollback as a ghost row.
  //
  // The fix: a synchronous SIGWINCH handler (wired in TerminalCompositor)
  // calls resetGeometry() before any debounced repaint can fire, so the
  // next render() has previousLineCount=0 — the erase pass is a no-op and
  // a fresh full-paint at the new geometry follows.
  // -------------------------------------------------------------------------

  it('resetGeometry() zeroes previous-frame coordinates so next render() skips erase', () => {
    const stream = makeMockStream(true, 80, 24);
    // Attach an initial data listener so the PassThrough enters flow mode and
    // doesn't buffer first-render writes — otherwise our later "capture only
    // the next render" listener would receive ALL accumulated writes.
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // Render a 3-line frame: previousTopRow=21, previousLineCount=3.
    renderer.render('a\nb\nc', 23);
    expect(renderer.topRow).toBe(21);
    void allWrites();

    // Resize: caller updates stream.rows AND calls resetGeometry() (the
    // exact sequence wired in TerminalCompositor's immediate resize handler).
    renderer.resetGeometry();
    expect(renderer.topRow).toBe(0);

    stream.rows = 40;

    // Capture only the next render() output to inspect the erase pass.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.render('x\ny\nz', 39);
    const out = chunks.join('');

    // Pre-fix: out would contain CUP escapes targeting rows 21..23 (the
    // erase pass against stale previousTopRow/previousLineCount). Post-fix:
    // resetGeometry() set previousLineCount=0, the erase loop has zero
    // iterations, and only the new-frame CUPs (37, 38, 39) appear.
    expect(out).not.toContain('\x1b[21;1H');
    expect(out).not.toContain('\x1b[22;1H');
    // Row 23 IS expected — it's where the OLD frame's last line sat AND the
    // erase pass would have CUPped to row 23 with ERASE_LINE. After reset,
    // row 23 should NOT appear at all in the new render (new top=37).
    expect(out).not.toContain('\x1b[23;1H');
    // New-frame CUPs: top row 37, bottom row 39.
    expect(out).toContain('\x1b[37;1H');
    expect(out).toContain('\x1b[39;1H');
    // Content present.
    expect(out).toContain('x');
    expect(out).toContain('y');
    expect(out).toContain('z');
  });

  it('resetGeometry() prevents off-screen CUP escapes on SHRINK (24 → 12 rows)', () => {
    // Shrink-path counterpart to the expand-case test above. Pre-fix bug
    // shape on shrink: previousTopRow=21, previousLineCount=3 from a 3-line
    // frame at rows=24. After SIGWINCH to rows=12, the erase pass without
    // reset would emit CUP escapes to rows 21, 22, 23 — all now beyond the
    // new 12-row viewport. Terminals handle off-screen CUPs inconsistently
    // (some clamp to last row, some no-op), and either way the pre-shrink
    // frame can survive into scrollback as a ghost row.
    //
    // Post-fix: resetGeometry() zeroes previousLineCount, so the next
    // render() emits ONLY new-geometry CUPs (rows 9, 10, 11 for a 3-line
    // frame at bottomRow=11). No row ≥ 12 should appear in the output.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // Render a 3-line frame at the original 24-row geometry.
    renderer.render('a\nb\nc', 23);
    expect(renderer.topRow).toBe(21);
    void allWrites();

    // Shrink: caller updates stream.rows AND calls resetGeometry() (matches
    // TerminalCompositor's immediate resize handler wiring).
    renderer.resetGeometry();
    stream.rows = 12;

    // Capture only the post-shrink render.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.render('x\ny\nz', 11);
    const out = chunks.join('');

    // No CUP escapes targeting rows ≥ 12 — those would land off-screen and
    // either clamp (corrupting on-screen content) or leak the pre-shrink
    // frame into scrollback.
    expect(out).not.toMatch(/\x1b\[1[2-9];1H/); // rows 12-19
    expect(out).not.toMatch(/\x1b\[[2-9]\d;1H/); // rows 20-99
    // Specifically: no CUPs to the previous frame's row coordinates (21-23).
    expect(out).not.toContain('\x1b[21;1H');
    expect(out).not.toContain('\x1b[22;1H');
    expect(out).not.toContain('\x1b[23;1H');
    // New-frame CUPs at the new geometry: rows 9, 10, 11.
    expect(out).toContain('\x1b[9;1H');
    expect(out).toContain('\x1b[10;1H');
    expect(out).toContain('\x1b[11;1H');
    // Content present at the new viewport.
    expect(out).toContain('x');
    expect(out).toContain('y');
    expect(out).toContain('z');
  });

  it('resetGeometry() is a no-op when no previous frame has been rendered', () => {
    const stream = makeMockStream(true, 80, 24);
    const renderer = new CupFrameRenderer(stream);

    // No render() yet — fields are already 0.
    expect(renderer.topRow).toBe(0);

    // resetGeometry() must not throw and must not change the state.
    expect(() => renderer.resetGeometry()).not.toThrow();
    expect(renderer.topRow).toBe(0);
  });

  it('after resetGeometry() the second render() correctly tracks new previous geometry', () => {
    // Pin the contract that resetGeometry() only invalidates ONCE — the
    // very next render() repopulates previousTopRow/previousLineCount as
    // usual, so subsequent renders behave normally.
    const stream = makeMockStream(true, 80, 24);
    // Drain prior writes via flow mode so we capture ONLY the third render.
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    renderer.render('first', 23);
    renderer.resetGeometry();
    renderer.render('second line a\nsecond line b', 23); // 2 lines → top=22

    expect(renderer.topRow).toBe(22);
    void allWrites();

    // A third render should erase the second frame's two rows (22, 23) —
    // proving the geometry tracking re-engaged after the reset.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.render('third', 23); // 1 line → top=23
    const out = chunks.join('');

    // Erase pass for previous 2-line frame: CUPs at rows 22 and 23.
    expect(out).toContain('\x1b[22;1H');
    expect(out).toContain('\x1b[23;1H');
    // New content.
    expect(out).toContain('third');
  });

  // -------------------------------------------------------------------------
  // Bug B regression: shrink gap — orphan blank rows when newLineCount <
  // previousLineCount.
  //
  // Pre-fix: first render occupies rows 11..20 (10 lines, bottomRow=20).
  // Second render has only 3 lines: newTopRow = 20 - 3 + 1 = 18. Erase loop
  // covered rows 11..20 (correct). Write loop covered only rows 18..20. Rows
  // 11..17 were erased but never rewritten — visible as 7 orphan blank rows.
  //
  // Fix (Strategy 2): prepend 7 blank rows to frameLines so the write loop
  // covers rows 11..20, overwriting the upper erased rows with blank content.
  // -------------------------------------------------------------------------

  it('repaints the shrink gap when newLineCount < previousLineCount', () => {
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // Render 1: 10 lines at bottomRow=20 → frame occupies rows 11..20.
    const frame1 = Array.from({ length: 10 }, (_, i) => `row${i + 1}`).join('\n');
    renderer.render(frame1, 20);
    expect(renderer.topRow).toBe(11);
    void allWrites();

    // Capture only Render 2 output.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));

    // Render 2: 3 lines at bottomRow=20. Content sits at rows 18..20; rows
    // 11..17 must be covered by blank rewrites (no orphan gap).
    renderer.render('line1\nline2\nline3', 20);
    const out2 = chunks.join('');

    // The write loop must cover ALL rows from 11 to 20 (padded to 10 rows).
    // Rows 11..17 are blank-overwritten (the padding), rows 18..20 are content.
    for (let row = 11; row <= 20; row++) {
      expect(out2).toContain(`\x1b[${row};1H`);
    }

    // Content lines appear at rows 18, 19, 20.
    expect(out2).toContain('line1');
    expect(out2).toContain('line2');
    expect(out2).toContain('line3');

    // No bare newlines — the CUP-only invariant still holds.
    expect(countBareNewlines(out2)).toBe(0);
  });

  it('clamps the shrink-pad to anchorFloor — never writes above a banner ceiling', () => {
    // Regression: typing a slash command as the FIRST message opened the
    // autocomplete dropdown (a tall frame); closing it (a large shrink) padded
    // enough blank rows that newTopRow climbed above the welcome-banner ceiling,
    // blanking the bottom of the goblin logo and opening a gap. With
    // anchorFloor=12 (banner occupies rows 1..11), the padded top must never
    // rise above row 12.
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // Render 1: a 9-row "open dropdown" frame just below the banner,
    // bottomRow=20 → occupies rows 12..20 (top pinned at the floor).
    const dropdown = Array.from({ length: 9 }, (_, i) => `menu${i + 1}`).join('\n');
    renderer.render(dropdown, 20, 12);
    expect(renderer.topRow).toBe(12);
    void allWrites();

    // Render 2: dropdown closes → 2-row input frame at bottomRow=14. The raw
    // shrink delta is 7, but the floor clamp caps the pad to 1 so newTopRow=12.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.render('input\n> ', 14, 12);
    const out2 = chunks.join('');

    // No CUP write may target any banner row (1..11).
    for (let row = 1; row <= 11; row++) {
      expect(out2, `must not touch banner row ${row}`).not.toContain(`\x1b[${row};1H`);
    }
    // Frame top stays at or below the floor; content is still bottom-pinned.
    expect(renderer.topRow).toBeGreaterThanOrEqual(12);
    expect(out2).toContain('input');
    expect(countBareNewlines(out2)).toBe(0);
  });

  it('does not pad on grow (larger frame than previous)', () => {
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    // Render 1: 3 lines at bottomRow=20 → frame occupies rows 18..20.
    renderer.render('a\nb\nc', 20);
    expect(renderer.topRow).toBe(18);
    void allWrites();

    // Capture only Render 2 output.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));

    // Render 2: 10 lines at bottomRow=20. No padding needed (grow case).
    const frame2 = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    renderer.render(frame2, 20);
    const out2 = chunks.join('');

    // Frame 2 occupies rows 11..20 (10 lines, no padding).
    for (let row = 11; row <= 20; row++) {
      expect(out2).toContain(`\x1b[${row};1H`);
    }

    // All 10 content lines present.
    for (let i = 1; i <= 10; i++) {
      expect(out2).toContain(`line${i}`);
    }

    // No bare newlines.
    expect(countBareNewlines(out2)).toBe(0);

    // Verify topRow reflects the new 10-line frame (top = 11).
    expect(renderer.topRow).toBe(11);
  });

  it('third render after shrink covers the correct footprint (chain stability)', () => {
    // Verifies that after a padded shrink render, the NEXT render's erase loop
    // correctly uses the padded lineCount (not raw) as previousLineCount so it
    // covers the full footprint written by the padded render.
    //
    // Render 1: 10 lines → rows 11..20 (previousLineCount = 10, previousTopRow = 11)
    // Render 2: 3 lines → padded to 10 → rows 11..20 (footprint unchanged)
    //           After: previousLineCount = 10, previousTopRow = 11
    // Render 3: 1 line → padded to 10 → rows 11..20 (erases and rewrites correctly)
    const stream = makeMockStream(true, 80, 24);
    const allWrites = collectWrites(stream);
    const renderer = new CupFrameRenderer(stream);

    const frame1 = Array.from({ length: 10 }, (_, i) => `r${i + 1}`).join('\n');
    renderer.render(frame1, 20);
    void allWrites();

    renderer.render('a\nb\nc', 20); // Render 2: shrink to 3
    void allWrites(); // consume

    // Capture Render 3.
    const chunks: string[] = [];
    (stream as NodeJS.ReadWriteStream).on('data', (c: unknown) => chunks.push(String(c)));
    renderer.render('only', 20); // Render 3: 1 line
    const out3 = chunks.join('');

    // The erase loop + write loop for Render 3 must cover the full footprint
    // inherited from Render 2 (rows 11..20). No orphan rows.
    for (let row = 11; row <= 20; row++) {
      expect(out3).toContain(`\x1b[${row};1H`);
    }

    expect(out3).toContain('only');
    expect(countBareNewlines(out3)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Ratchet regression: the live frame must VISUALLY shrink across renders
  // when raw content shrinks, not stay locked at the peak high-water mark.
  //
  // Pre-fix mechanism: `previousLineCount` was both the shrink-detection
  // reference AND the padded on-screen footprint. After a shrink, it was
  // updated to the padded value (== old peak), so every subsequent shorter
  // render re-padded back to that peak — `newTopRow` never moved downward,
  // and `topRow` reported the peak's top forever. A long agent-afk session
  // that peaked tall (e.g. skill + parallel subagents + nested tools) and
  // then collapsed to a few in-flight items rendered as a frame mostly made
  // of blank padding above the actual content — the user-reported "huge
  // gap" between the bottom of scrollback and the top of live content.
  //
  // Post-fix: padded `previousLineCount` (for erase coverage) and raw
  // `previousRawLineCount` (for shrink detection) are tracked separately.
  // `previousRawLineCount` decreases with raw content, so subsequent shrink
  // padding is bounded by the raw-to-raw delta — `newTopRow` drops toward
  // `bottomRow` and `topRow` reports the smaller frame's actual top, which
  // lets `commitAbove` write fresh scrollback into the freed area.
  // -------------------------------------------------------------------------
  it('frame visually shrinks across consecutive shrink renders (ratchet regression)', () => {
    const stream = makeMockStream(true, 80, 24);
    const renderer = new CupFrameRenderer(stream);

    // R1 — peak: 10 lines occupying rows 11..20. topRow = 11.
    const frame1 = Array.from({ length: 10 }, (_, i) => `r${i + 1}`).join('\n');
    renderer.render(frame1, 20);
    expect(renderer.topRow).toBe(11);

    // R2 — first shrink: raw=3. Intra-render padding maintains the on-screen
    // footprint at 10 rows so the erase loop's coverage matches the write
    // loop's coverage (Bug B contract). The padded frame still occupies rows
    // 11..20, so topRow stays at 11 for this render. The KEY effect is that
    // previousRawLineCount is now 3 (raw), not 10 (padded).
    renderer.render('a\nb\nc', 20);
    expect(renderer.topRow).toBe(11);

    // R3 — second shrink: raw=1. Pre-fix this would re-pad to 10 because
    // single-field previousLineCount was still 10 (ratcheted) — newTopRow
    // would stay 11. Post-fix, previousRawLineCount is 3 (from R2's raw),
    // so padding is bounded by 3-1 = 2 — the padded frame occupies rows
    // 18..20 (newTopRow = 20 - 3 + 1 = 18). topRow drops 7 rows downward.
    renderer.render('only', 20);
    expect(renderer.topRow).toBe(18);

    // R4 — third shrink would visually collapse to a single-line frame at
    // row 20. raw=1 again (no further reduction), so no padding fires.
    // newTopRow = 20 - 1 + 1 = 20. The frame is now flush at the bottom.
    renderer.render('flush', 20);
    expect(renderer.topRow).toBe(20);
  });

  // -------------------------------------------------------------------------
  // Invariant guard: padded lineCount >= raw lineCount (no false positives).
  //
  // The guard added in the follow-up to PR #557 throws in NODE_ENV !== production
  // when lineCount < rawLineCount. Verify it does NOT fire (no false positive)
  // on the three structurally valid render paths: grow, equal, and shrink.
  // The throw path (lineCount < rawLineCount) is structurally unreachable via
  // the current padding logic — testing the throw itself would require
  // extracting the private computation or subclassing, which is disproportionate
  // harness work for a guard that documents a compile-time structural contract.
  // -------------------------------------------------------------------------
  it('invariant guard produces no false positive on grow, equal, and shrink renders', () => {
    const stream = makeMockStream(true, 80, 24);
    const renderer = new CupFrameRenderer(stream);

    // Grow: 1 → 5 lines. lineCount === rawLineCount (no padding needed).
    expect(() => renderer.render('a', 20)).not.toThrow();
    expect(() =>
      renderer.render('a\nb\nc\nd\ne', 20),
    ).not.toThrow();

    // Equal: same line count. lineCount === rawLineCount.
    expect(() => renderer.render('x\ny\nz\nw\nv', 20)).not.toThrow();

    // Shrink: 5 → 2 lines. lineCount > rawLineCount (padding prepended).
    expect(() => renderer.render('p\nq', 20)).not.toThrow();
  });
});
