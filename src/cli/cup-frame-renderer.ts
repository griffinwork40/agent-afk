/**
 * CupFrameRenderer
 *
 * Replaces log-update inside TerminalCompositor. Instead of writing frame
 * content followed by a trailing `\n` (which triggers a scroll when the
 * cursor sits at the DECSTBM bottom margin), this renderer positions every
 * line with absolute CUP escapes (`\x1b[row;1H`) so no `\n` is ever emitted
 * during normal frame rendering.
 *
 * Root cause of the "jumping" bug it fixes:
 *   log-update appends a trailing `\n` to every frame
 *   (node_modules/log-update/index.js:189 — the `computeFrame` normalization).
 *   status-line.ts sets DECSTBM to (1, rows-1), so the bottom margin sits at
 *   row `rows-1`. TerminalCompositor.anchor() CUP-positioned the cursor AT
 *   `rows-1` before the first repaint, placing it exactly on that margin.
 *   When log-update wrote its first frame from that position, the trailing
 *   `\n` at the bottom margin caused a scroll, shifting all content up by 1
 *   row. A second scroll occurred on the wrap-transition path (`start === 0`
 *   branch) when input grew from 1 visible line to 2. These two scrolls
 *   accumulate as visible "compositor drift" — the user sees the frame jump
 *   upward mid-screen.
 *
 * Fix: CUP-position every line of the frame absolutely. Line transitions use
 * `\x1b[row;1H` instead of `\n`. The trailing blank at `targetBottomRow`
 * (the row just below the last content line, above the status line) is
 * written with CUP + erase-line, never via `\n`. The scroll region is never
 * triggered.
 *
 * Invariant (frame geometry):
 *   - `targetBottomRow` is always `rows - 1` (the row just above the status
 *     line at `rows`). Status line owns `rows` exclusively.
 *   - The last content line sits at `targetBottomRow - 1` when the frame has
 *     ≥ 2 lines, or at `targetBottomRow` itself for a 1-line frame.
 *   - Frames grow UPWARD as line count increases; the bottom is pinned.
 *   - `newTopRow = max(1, targetBottomRow - lineCount + 1)`.
 */

import wrapAnsi from 'wrap-ansi';
import type { Writable } from 'node:stream';
import { env } from '../config/env.js';

// Synchronized output — supported by xterm/iTerm2/Apple Terminal. Wrapping a
// frame write in these escapes prevents visible tearing when rendering multiple
// lines in a single operation.
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

// CUP: absolute cursor position. Rows and columns are 1-based.
const cup = (row: number, col: number): string => `\x1b[${row};${col}H`;

// Erase entire line at current cursor position (cursor does not move).
const ERASE_LINE = '\x1b[2K';

// Inline cursor visibility — avoids a direct dep on cli-cursor (which is only
// a transitive dep under log-update and not directly accessible under pnpm's
// strict hoisting). The escape codes are stable VT100/xterm sequences.
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';

export class CupFrameRenderer {
  private readonly stream: NodeJS.WriteStream & Writable;
  private previousTopRow = 0;
  private previousLineCount = 0;
  private previousRawLineCount = 0;

  constructor(stream: NodeJS.WriteStream & Writable) {
    this.stream = stream;
  }

  /**
   * The top row of the most recently rendered frame. Returns 0 if no frame
   * has been rendered (or the previous frame was cleared without a follow-up
   * render). Used by `TerminalCompositor.commitAbove`'s phase 3 to position
   * committed text at `newTopRow - lineCount..newTopRow - 1` (immediately
   * above the live frame) so it's visible without scrolling in addition
   * to being preserved in scrollback by phase 1.
   */
  get topRow(): number {
    return this.previousTopRow;
  }

  /**
   * Wrap `content` to `width` exactly as render() does — {trim:false,
   * hard:true, wordWrap:false} with a guaranteed trailing newline for
   * consistent normalization — and return the physical (post-wrap) visible
   * lines, trailing empty element(s) dropped. Shared by render() and measure()
   * so the physical row count can never drift between them.
   */
  private static wrapToPhysicalLines(content: string, width: number): string[] {
    const raw = content.endsWith('\n') ? content : `${content}\n`;
    const wrapped = wrapAnsi(raw, width, { trim: false, hard: true, wordWrap: false });
    const allLines = wrapped.split('\n');
    while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    return allLines;
  }

  /**
   * Predict the physical top row the next `render(content, targetBottomRow)`
   * will use, WITHOUT rendering or mutating tracked state. CupFrameRenderer
   * hard-wraps at `stream.columns`, so a frame line wider than the terminal
   * occupies >1 physical row. Callers (TerminalCompositor repaint /
   * repaintPickerFrame) use this to size committed-band eviction + re-pin
   * against the PHYSICAL frame footprint; the logical line count under-counts
   * whenever a line soft-wraps and re-pins the band INSIDE the frame, where the
   * next render's erase pass clobbers it (review #592).
   *
   * Returns the raw (wrapped, pre-shrink-padding) top: shrink padding is a
   * transient one-render artifact handled inside render(), and the band is
   * pinned against the real content top — `bottomRow - rawLineCount + 1`. In
   * the common case where nothing wraps this equals the logical line count, so
   * callers see byte-identical geometry.
   */
  measure(content: string, targetBottomRow: number): { topRow: number; lineCount: number } {
    const width = this.stream.columns ?? 80;
    const rawLineCount = Math.max(1, CupFrameRenderer.wrapToPhysicalLines(content, width).length);
    const bottomRow = Math.max(1, targetBottomRow);
    return { topRow: Math.max(1, bottomRow - rawLineCount + 1), lineCount: rawLineCount };
  }

  /**
   * Render `content` so that the last content line sits at `targetBottomRow`.
   * Lines are positioned with CUP escapes — no `\n` is written for line
   * transitions, so the DECSTBM scroll region is never triggered.
   *
   * Contract:
   *   - `content` is the raw frame string (may contain ANSI codes).
   *   - `targetBottomRow` is 1-based; caller passes `rows - 1`.
   *   - If `targetBottomRow < 1`, defaults to 1.
   */
  render(content: string, targetBottomRow: number): void {
    const bottomRow = Math.max(1, targetBottomRow);
    const width = this.stream.columns ?? 80;
    const useSyncOutput = this.stream.isTTY === true;

    // Wrap via the shared helper measure() also uses, so the physical row count
    // repaint() predicted (via measure) matches what we actually render here.
    const allLines = CupFrameRenderer.wrapToPhysicalLines(content, width);
    const rawLineCount = Math.max(1, allLines.length);

    // Invariant (bottom-anchored shrink coverage): when raw content shrinks
    // between renders, the write loop covers only the smaller new footprint
    // (newTopRow..bottomRow). The erase loop covers the FULL previous on-
    // screen footprint (previousLineCount, padded). Pad with blank rows so
    // the write loop covers the same rows the erase loop cleared within
    // this render — preventing intra-render orphan blanks (see the
    // 'repaints the shrink gap' regression test).
    //
    // Shrink detection uses previousRawLineCount (the prior render's raw
    // content size), NOT previousLineCount (padded footprint). Splitting
    // them lets the live frame visually shrink across renders: subsequent
    // shrink padding is bounded by raw-to-raw delta, not by the peak
    // high-water mark. Single-field tracking ratcheted previousLineCount up
    // to peak and never decreased — the live frame stayed locked at peak
    // height forever even when overlay content collapsed (user-reported
    // 'huge gap' between scrollback and live content).
    const frameLines =
      this.previousRawLineCount > rawLineCount
        ? [
            ...Array<string>(this.previousRawLineCount - rawLineCount).fill(''),
            ...allLines,
          ]
        : allLines;

    const lineCount = frameLines.length;

    // Compute where the frame top lands (grows upward from bottomRow).
    const newTopRow = Math.max(1, bottomRow - lineCount + 1);

    // Build output: erase previous frame + write new frame, all via CUP.
    let out = '';

    if (useSyncOutput) {
      out += SYNC_START;
    }

    // Erase the previous frame's rows. Covers cases where the new frame is
    // shorter than the previous (rows that would otherwise be stale on screen).
    if (this.previousLineCount > 0) {
      for (let i = 0; i < this.previousLineCount; i++) {
        const row = this.previousTopRow + i;
        out += cup(row, 1) + ERASE_LINE;
      }
    }

    // Write new frame lines via CUP. The last content line lands at bottomRow.
    // frameLines may be padded at the top with blank rows (shrink case) — those
    // blank rows overwrite the previously-occupied upper rows without content.
    for (let i = 0; i < lineCount; i++) {
      const row = newTopRow + i;
      out += cup(row, 1) + ERASE_LINE + (frameLines[i] ?? '');
    }

    // Leave cursor parked at the last content row, column 1 (matches where a
    // user would expect the cursor after rendering the input line).
    out += cup(newTopRow + lineCount - 1, 1);

    if (useSyncOutput) {
      out += SYNC_END;
    }

    // Hide cursor during render (mirrors log-update's showCursor=false default).
    // Written outside the sync block so terminals that don't support synchronized
    // output still see the hide before the frame content flashes.
    if (this.stream.isTTY) {
      try {
        this.stream.write(CURSOR_HIDE);
      } catch {
        // noop
      }
    }

    try {
      this.stream.write(out);
    } catch {
      // Invariant: if the frame write fails AFTER CURSOR_HIDE was emitted
      // successfully (two distinct write() calls — see line 135), the cursor
      // is left invisible on the host terminal. Restore visibility best-
      // effort so a partial teardown doesn't strand a phantom-hidden cursor.
      // Matches the silent-swallow pattern used in clear()/done() below.
      try {
        if (this.stream.isTTY) this.stream.write(CURSOR_SHOW);
      } catch {
        // Terminal fully gone — nothing more we can do.
      }
    }

    // Track padded lineCount as the on-screen footprint (erase-loop reference
    // for the next render). Track rawLineCount separately for shrink detection
    // — see the Invariant block above for why both are needed. Using only
    // padded would re-create the high-water-mark ratchet; using only raw
    // would under-erase the previous render's padded footprint and leave
    // stale orphan rows.
    //
    // Invariant (padded >= raw): lineCount is frameLines.length — either equal
    // to rawLineCount (grow/same case) or rawLineCount + blank-padding rows
    // (shrink case). It can never be less than rawLineCount; if it were,
    // the erase loop would under-cover the write loop's footprint and leave
    // orphan rows. This guard catches any future edit that re-conflates the
    // two fields or changes the padding logic in a way that breaks the
    // padded-covers-raw contract introduced in PR #557.
    if (env.NODE_ENV !== 'production' && lineCount < rawLineCount) {
      throw new Error(
        `CupFrameRenderer invariant violation: lineCount (${lineCount}) < rawLineCount (${rawLineCount}). ` +
          `previousLineCount must cover at least previousRawLineCount — padded footprint must be ≥ raw content size; see PR #557.`,
      );
    }
    this.previousTopRow = newTopRow;
    this.previousLineCount = lineCount;
    this.previousRawLineCount = rawLineCount;
  }

  /**
   * Drop tracked previous-frame coordinates. Wired to a synchronous SIGWINCH
   * handler so the next render() after a terminal resize skips the erase
   * pass and performs a fresh full-paint at the new geometry.
   *
   * Invariant (SIGWINCH-safe geometry): on resize, `previousTopRow` and
   * `previousLineCount` refer to row coordinates that no longer correspond
   * to visible screen positions. Without a reset, the next render() does:
   *
   *   - SHRINK (rows decreased): the erase pass CUPs to `previousTopRow + i`
   *     for i ∈ [0, previousLineCount). Rows beyond the new terminal height
   *     are clamped by the terminal — those erase commands no-op and the
   *     pre-resize frame content in scrollback survives unerased.
   *   - EXPAND (rows increased): the new frame paints higher up because
   *     `targetBottomRow = rows-1` increased. The erase covers the old
   *     (lower) band correctly, but rows between the old top and the new
   *     top are neither erased nor written — they show as a blank stripe.
   *
   * Zeroing both fields makes the erase pass a no-op for the next render(),
   * so a full new-geometry frame is painted from scratch with no stale
   * coordinates participating in the math.
   */
  resetGeometry(): void {
    this.previousTopRow = 0;
    this.previousLineCount = 0;
    this.previousRawLineCount = 0;
  }

  /**
   * Erase the previously rendered frame and reset tracking state. Equivalent
   * to log-update's `render.clear()`. Does NOT restore the cursor — callers
   * must call `done()` separately to show the cursor.
   */
  clear(extraRows: number = 0): void {
    if (this.previousLineCount === 0) return;

    let out = '';
    const useSyncOutput = this.stream.isTTY === true;

    if (useSyncOutput) {
      out += SYNC_START;
    }

    for (let i = 0; i < this.previousLineCount; i++) {
      const row = this.previousTopRow + i;
      out += cup(row, 1) + ERASE_LINE;
    }

    // Invariant (DECSTBM scrollback push): clear() must park the cursor at
    // `rows - 1 - extraRows` — the bottom of the active scroll sub-region
    // (accounting for rows reserved by BackgroundStatusBar) — so the
    // subsequent stdout.write(text + '\n') in commitAbove() (terminal-
    // compositor.ts ~789) lands its trailing `\n` at the bottom margin and
    // triggers a scroll. Under the withFullScrollRegion guard that wraps the
    // commitAbove write, that scroll pushes the displaced top line into the
    // terminal's scrollback buffer.
    //
    // Parking at `previousTopRow` (the top of the prior frame) is incorrect
    // when the prior frame was multi-line: previousTopRow is then above
    // rows-1, the CUP-positioned write lands mid-screen, and the trailing
    // `\n` does NOT reach the scroll-region bottom — so no scroll fires and
    // the committed text sits at a frame-occupied row that the next repaint()
    // either silently erases or leaves stranded mid-viewport with empty
    // scrollback above. This is the visible "nothing committed to scrollback"
    // regression: short committed strings get painted at the old overlay's
    // top row and never enter scrollback.
    //
    // For a 1-line idle frame (previousTopRow === rows-1-extraRows) this is a no-op.
    out += cup(Math.max(1, (this.stream.rows ?? 24) - 1 - extraRows), 1);

    if (useSyncOutput) {
      out += SYNC_END;
    }

    try {
      this.stream.write(out);
    } catch {
      // noop
    }

    this.previousTopRow = 0;
    this.previousLineCount = 0;
    this.previousRawLineCount = 0;
  }

  /**
   * Show the cursor. Equivalent to log-update's `render.done()`. Called by
   * TerminalCompositor.disarm() after clear() to restore cursor visibility.
   */
  done(): void {
    this.previousTopRow = 0;
    this.previousLineCount = 0;
    this.previousRawLineCount = 0;
    if (this.stream.isTTY) {
      try {
        this.stream.write(CURSOR_SHOW);
      } catch {
        // noop
      }
    }
  }
}
