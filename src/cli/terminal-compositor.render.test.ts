/**
 * Unit tests for terminal-compositor.render free functions.
 *
 * These tests exercise the pure string-producer functions directly, without
 * spinning up a full TerminalCompositor. The minimal RenderHost mock only
 * supplies the fields each function reads.
 */

import { describe, it, expect } from 'vitest';
import { renderDropdownRows, renderInputLine } from './terminal-compositor.render.js';
import type { RenderHost } from './terminal-compositor.render.js';
import { displayWidth, stripAnsi } from './display.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { Candidate } from './input/types.js';
import { palette } from './palette.js';

// ---------------------------------------------------------------------------
// Minimal RenderHost factory — only the fields renderDropdownRows reads.
// ---------------------------------------------------------------------------
function makeHost(cols: number, candidates: Candidate[]): RenderHost {
  const ac: AutocompleteState = {
    dropdownOpen: true,
    candidates,
    selectedIndex: 0,
    viewportStart: 0,
    suppressedSignature: null,
    trigger: null,
    reset() { /* no-op for tests */ },
  };
  return {
    queued: false,
    pendingSubmissions: [],
    input: { buffer: '', cursor: 0 },
    activeGhost: null,
    autocompleteState: ac,
    promptTextFn: () => '> ',
    stdout: { columns: cols } as NodeJS.WriteStream,
  };
}

// ---------------------------------------------------------------------------
// renderDropdownRows — wide-char soft-wrap height fix
// ---------------------------------------------------------------------------

describe('renderDropdownRows — wide-char soft-wrap counting', () => {
  it('does not produce extra blank placeholder rows for ASCII candidates', () => {
    // A short ASCII candidate fits in one display row — no soft-wrap placeholder.
    const host = makeHost(80, [{ value: '/mint', summary: 'Run mint' }]);
    const rows = renderDropdownRows(host);
    // One candidate → one formatted row, no blank placeholders.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('/mint');
  });

  it('measures wide-char (CJK) candidates in display columns, not UTF-16 length', () => {
    // '東京都市' has .length === 4 but display width === 8 (each char is 2
    // terminal columns). The fix measures the rendered row with displayWidth
    // (matching `cols`, also display columns) instead of .length.
    //
    // A test that distinguishes displayWidth from a naive .length purely via the
    // soft-wrap COUNT is not constructable at this layer: formatDropdownRow
    // truncates every row to `min(cols-4, 60)` display columns — always < cols —
    // so softWraps is 0 for any well-formed CJK row no matter which width measure
    // the source uses. We therefore pin the observable contract instead: wide
    // content that fits the budget produces exactly one row with no phantom
    // soft-wrap placeholders, and the rendered row's display width stays within
    // the terminal (i.e. it was truncated/measured in display columns).
    const cols = 41; // smallest width that passes the `cols > 40` guard
    const host = makeHost(cols, [{ value: '東京都市', summary: '東京の候補' }]);
    const rows = renderDropdownRows(host);
    const blanks = rows.filter((r) => r === '');
    const nonBlank = rows.filter((r) => r !== '');
    expect(nonBlank).toHaveLength(1);
    expect(blanks).toHaveLength(0);
    expect(displayWidth(stripAnsi(nonBlank[0]!))).toBeLessThanOrEqual(cols);
  });

  it('emits one row per fitting candidate with the value preserved and no phantom blanks', () => {
    // formatDropdownRow truncates each row to min(cols-4, 60) display columns,
    // so a normal ASCII candidate always fits in one visual row. Assert the real
    // structural contract (the prior version asserted `blanks.length >= 0` and
    // `toBeTruthy()` on already-non-empty rows — both vacuously true):
    //   - exactly one rendered (non-blank) row,
    //   - zero blank soft-wrap placeholders,
    //   - the rendered row carries the candidate value.
    const host = makeHost(50, [{ value: '/test-cmd', summary: 'Summary text here' }]);
    const rows = renderDropdownRows(host);
    const blanks = rows.filter((r) => r === '');
    const nonBlanks = rows.filter((r) => r !== '');
    expect(nonBlanks).toHaveLength(1);
    expect(blanks).toHaveLength(0);
    expect(nonBlanks.every((r) => stripAnsi(r).includes('/test-cmd'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderInputLine — caret blink phase (▏ thin-bar pulse)
// ---------------------------------------------------------------------------

const THIN_BAR = '\u258f'; // ▏ LEFT ONE EIGHTH BLOCK

function makeInputHost(opts: {
  buffer: string;
  cursor: number;
  caretVisible?: boolean;
  activeGhost?: string | null;
  promptTextFn?: (buffer: string) => string;
}): RenderHost {
  return {
    queued: false,
    pendingSubmissions: [],
    input: { buffer: opts.buffer, cursor: opts.cursor },
    ...(opts.caretVisible !== undefined ? { caretVisible: opts.caretVisible } : {}),
    activeGhost: opts.activeGhost ?? null,
    promptTextFn: opts.promptTextFn ?? (() => '> '),
    stdout: { columns: 80 } as NodeJS.WriteStream,
  };
}

describe('renderInputLine — shell mode', () => {
  it.each([
    ['!', 'command'],
    ['!git status', '  (shell)'],
    ['!&pnpm test', '  (shell: background)'],
    ['!&', '  (shell: background)'],
  ])('renders the fixed ghost hint for %s', (buffer, hint) => {
    const line = renderInputLine(makeInputHost({
      buffer,
      cursor: buffer.length,
      activeGhost: buffer + ' competing suggestion',
      promptTextFn: (liveBuffer) => liveBuffer.startsWith('!') ? '$ ' : '> ',
    }));
    expect(stripAnsi(line)).toBe(`$ ${buffer}${THIN_BAR}${hint}`);
  });

  it('renders shell ghost hints in palette.meta, not palette.dim', () => {
    const previousLevel = palette.meta.level;
    palette.meta.level = 3;
    try {
      const line = renderInputLine(makeInputHost({
        buffer: '!git status',
        cursor: '!git status'.length,
        activeGhost: '!git status --verbose',
        promptTextFn: () => '$ ',
      }));
      // Shell ghost hints use palette.meta (dim gray) — not palette.dim —
      // to read as a secondary hint distinct from the shell input tone.
      expect(line).toContain(palette.meta('  (shell)'));
      expect(line).not.toContain(palette.dim('  (shell)'));
    } finally {
      palette.meta.level = previousLevel;
    }
  });

  it('renders non-shell ghost suggestions in palette.dim', () => {
    const previousLevel = palette.dim.level;
    palette.dim.level = 3;
    try {
      const line = renderInputLine(makeInputHost({
        buffer: 'hello',
        cursor: 5,
        activeGhost: 'hello world',
      }));
      // Non-shell (history/LLM) ghosts use palette.dim — the pre-existing tone.
      expect(line).toContain(palette.dim(' world'));
    } finally {
      palette.dim.level = previousLevel;
    }
  });

  it('colors both sides of a mid-buffer caret with the shell tone', () => {
    const previousLevel = palette.shell.level;
    palette.shell.level = 3;
    try {
      const line = renderInputLine(makeInputHost({ buffer: '!echo hi', cursor: 3 }));
      expect(line).toContain(palette.shell('!ec'));
      expect(line).toContain(palette.shell('o hi'));
    } finally {
      palette.shell.level = previousLevel;
    }
  });
});

describe('renderInputLine — caret blink', () => {
  it('paints the ▏ thin-bar caret in the visible phase (end-of-buffer)', () => {
    const line = renderInputLine(makeInputHost({ buffer: '', cursor: 0, caretVisible: true }));
    expect(line).toContain(THIN_BAR);
  });

  it('blanks the caret in the off phase, preserving the one-cell width (end-of-buffer)', () => {
    const on = renderInputLine(makeInputHost({ buffer: '', cursor: 0, caretVisible: true }));
    const off = renderInputLine(makeInputHost({ buffer: '', cursor: 0, caretVisible: false }));
    // Off-phase drops the thin bar entirely…
    expect(off).not.toContain(THIN_BAR);
    // …and replaces it with a single blank cell — same display width as the
    // visible phase so the line never shifts as the caret pulses.
    expect(displayWidth(stripAnsi(off))).toBe(displayWidth(stripAnsi(on)));
    expect(stripAnsi(off)).toBe('>  '); // prompt '> ' + one blank caret cell
  });

  it('defaults to a solid caret when caretVisible is absent (non-blinking host)', () => {
    const line = renderInputLine(makeInputHost({ buffer: '', cursor: 0 }));
    expect(line).toContain(THIN_BAR);
  });

  it('off-phase mid-buffer reveals the underlying char un-inverted (block-cursor off)', async () => {
    // Cursor sits on the 'b' of 'abc'. The visible phase inverse-videos that
    // cell (SGR `\x1b[7m`); the off phase shows the bare character. Force chalk
    // colour so the inverse SGR is observable.
    const chalkModule = await import('chalk');
    const priorLevel = chalkModule.default.level;
    chalkModule.default.level = 1;
    try {
      const on = renderInputLine(makeInputHost({ buffer: 'abc', cursor: 1, caretVisible: true }));
      const off = renderInputLine(makeInputHost({ buffer: 'abc', cursor: 1, caretVisible: false }));
      expect(on).toContain('\x1b[7m'); // inverse-video open in the visible phase
      expect(off).not.toContain('\x1b[7m'); // off phase is un-inverted
      // Same single-cell width in both phases (no inverse ≠ width change).
      expect(displayWidth(stripAnsi(on))).toBe(displayWidth(stripAnsi(off)));
      expect(stripAnsi(off)).toContain('abc');
    } finally {
      chalkModule.default.level = priorLevel;
    }
  });
});

// ---------------------------------------------------------------------------
// renderInputLine — centered input viewport clipping (issue #2167)
//
// When AFK_CENTER_CONTENT=1 is set on a wide terminal, renderInputLine()
// prepends a left margin. A long input that fills the remaining columns must
// be clipped — NOT soft-wrapped — so CupFrameRenderer never hard-wraps
// continuation rows to column 0 (which would corrupt DECSTBM scroll-region
// row accounting and break the centered layout).
// ---------------------------------------------------------------------------

/** Run `fn` with AFK_CENTER_CONTENT set to `value`, then restore. */
function withCenterContent<T>(value: string, fn: () => T): T {
  const prev = process.env['AFK_CENTER_CONTENT'];
  process.env['AFK_CENTER_CONTENT'] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['AFK_CENTER_CONTENT'];
    else process.env['AFK_CENTER_CONTENT'] = prev;
  }
}

/**
 * Build a RenderHost with `cols` columns and optional centered-input props.
 * The prompt is '> ' (2 display columns).
 */
function makeCenteredHost(opts: {
  cols: number;
  buffer: string;
  cursor: number;
  activeGhost?: string | null;
}): RenderHost {
  return {
    queued: false,
    pendingSubmissions: [],
    input: { buffer: opts.buffer, cursor: opts.cursor },
    activeGhost: opts.activeGhost ?? null,
    promptTextFn: () => '> ',
    stdout: { columns: opts.cols } as NodeJS.WriteStream,
  };
}

describe('renderInputLine — centered input clipping (AFK_CENTER_CONTENT, issue #2167)', () => {
  // Contract: on a 150-col terminal with default 100-col measure,
  // contentMargin(150) = 25 spaces. With '> ' prompt (2 cols), the visible
  // buffer budget is 150 - 25 - 2 = 123 columns.
  //
  // A buffer exactly at the limit (123 printable chars + caret) fits without
  // clipping. A buffer one char over must be clipped so the rendered line
  // stays within 150 display columns.
  const COLS = 150;
  // margin = floor((150 - 100) / 2) = 25, prompt = 2, budget = 123
  const MARGIN = 25;
  const PROMPT_WIDTH = 2; // '> '
  const AVAILABLE = COLS - MARGIN - PROMPT_WIDTH; // 123

  it('does not clip a buffer that fits within available columns', () => {
    // A buffer of exactly (available - 1) printable chars occupies 123 display
    // cols: before (122) + caret (1) = 123 = AVAILABLE. No clipping expected.
    const buffer = 'a'.repeat(AVAILABLE - 1); // 122 chars, caret at end = 123 cols
    withCenterContent('1', () => {
      const host = makeCenteredHost({ cols: COLS, buffer, cursor: buffer.length });
      const line = renderInputLine(host);
      const stripped = stripAnsi(line);
      // Must not exceed terminal width.
      expect(displayWidth(stripped)).toBeLessThanOrEqual(COLS);
      // Buffer content is visible.
      expect(stripped).toContain(buffer.slice(0, 10));
    });
  });

  it('clips a long buffer so the rendered line fits within terminal columns', () => {
    // A buffer of (available + 20) chars would overflow without clipping.
    const buffer = 'x'.repeat(AVAILABLE + 20);
    withCenterContent('1', () => {
      const host = makeCenteredHost({ cols: COLS, buffer, cursor: buffer.length });
      const line = renderInputLine(host);
      // Contract: line width ≤ COLS — no continuation wrapping to column 0.
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(COLS);
    });
  });

  it('keeps the caret visible in the clipped viewport (cursor at end)', () => {
    const THIN_BAR = '\u258f'; // ▏ LEFT ONE EIGHTH BLOCK
    const buffer = 'y'.repeat(AVAILABLE + 30); // well past the budget
    withCenterContent('1', () => {
      const host = makeCenteredHost({ cols: COLS, buffer, cursor: buffer.length });
      const line = renderInputLine(host);
      // The caret cell must always be present regardless of clipping depth.
      expect(line).toContain(THIN_BAR);
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(COLS);
    });
  });

  it('clips the after portion when cursor is mid-buffer', () => {
    // Cursor at position 5; rawBefore is short but rawAfter is very long.
    const prefix = 'hello';
    const rest = 'z'.repeat(AVAILABLE + 40);
    const buffer = prefix + rest;
    withCenterContent('1', () => {
      const host = makeCenteredHost({ cols: COLS, buffer, cursor: prefix.length });
      const line = renderInputLine(host);
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(COLS);
      // The prefix before the cursor must be visible.
      expect(stripAnsi(line)).toContain(prefix);
    });
  });

  it('the rendered line is a single logical line (no embedded newline)', () => {
    // Embedded newlines would corrupt DECSTBM scroll-region accounting.
    const buffer = 'm'.repeat(AVAILABLE + 50);
    withCenterContent('1', () => {
      const host = makeCenteredHost({ cols: COLS, buffer, cursor: buffer.length });
      const line = renderInputLine(host);
      expect(line).not.toContain('\n');
    });
  });

  it('returns an unclipped line when centering is disabled (no AFK_CENTER_CONTENT)', () => {
    // Without centering the margin is '', so the existing ghost-only budget
    // governs. A moderately long buffer should not be clipped by the new code.
    const buffer = 'q'.repeat(60); // fits comfortably on 80-col default
    const host = makeCenteredHost({ cols: 80, buffer, cursor: buffer.length });
    // No withCenterContent — AFK_CENTER_CONTENT is unset.
    const line = renderInputLine(host);
    // The full buffer is present (no '…' from scroll clipping).
    expect(stripAnsi(line)).toContain(buffer);
  });
});
