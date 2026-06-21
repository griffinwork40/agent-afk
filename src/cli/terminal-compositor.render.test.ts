/**
 * Unit tests for terminal-compositor.render free functions.
 *
 * These tests exercise the pure string-producer functions directly, without
 * spinning up a full TerminalCompositor. The minimal RenderHost mock only
 * supplies the fields each function reads.
 */

import { describe, it, expect } from 'vitest';
import { renderDropdownRows } from './terminal-compositor.render.js';
import type { RenderHost } from './terminal-compositor.render.js';
import { displayWidth, stripAnsi } from './display.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { Candidate } from './input/types.js';

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
