/**
 * Tests for reader.reverse-search.ts — the incremental reverse-history-search
 * modal for the TTY REPL.
 *
 * Covers:
 *   - createReverseSearchState: fresh inactive state
 *   - enterReverseSearch: saves buffer, resets query+match
 *   - cancelReverseSearch: restores saved buffer
 *   - acceptReverseSearch: keeps current buffer, deactivates
 *   - findNextMatch: prefix, substring, cycling, no-match, empty query
 *   - renderReverseSearchLine: prompt format
 *   - handleReverseSearchKey:
 *       Ctrl-R (cycle), Esc/Ctrl-G (cancel), Enter (accept, fall-through),
 *       Ctrl-C (cancel + fall-through), Backspace (trim query), printable
 *       chars (extend query), unrecognised keys (accept + fall-through)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createReverseSearchState,
  enterReverseSearch,
  cancelReverseSearch,
  acceptReverseSearch,
  findNextMatch,
  renderReverseSearchLine,
  handleReverseSearchKey,
  type ReverseSearchState,
} from './reader.reverse-search.js';
import { InputCore } from '../input-core.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx } from './reader.repaint.js';
import type { AutocompleteState } from './autocomplete-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReaderState for testing. */
function makeState(buffer = ''): ReaderState {
  const ac: AutocompleteState = {
    dropdownOpen: false,
    candidates: [],
    selectedIndex: 0,
    viewportStart: 0,
    suppressedSignature: null,
    trigger: null,
    reset() {
      this.dropdownOpen = false;
      this.candidates = [];
      this.selectedIndex = 0;
      this.viewportStart = 0;
      this.suppressedSignature = null;
      this.trigger = null;
    },
  };
  return {
    input: InputCore.seed(buffer),
    ac,
    rowsBelow: 0,
    pasting: false,
    clipboardInFlight: false,
    pasteStartBufferLen: 0,
    prevBufferRows: 0,
    prevStatusRows: 0,
    clipboardFailureMsg: null,
    attachments: [],
    maxDropdownRows: 6,
    lastKeypressAt: 0,
    repaintPending: false,
    settled: false,
    reverseSearch: createReverseSearchState(),
  };
}

/** Minimal RepaintCtx that doesn't touch stdout. */
function makeRepaintCtx(): RepaintCtx {
  return {
    stdout: {
      write: vi.fn(() => true),
      columns: 80,
    } as unknown as NodeJS.WriteStream,
    promptText: '> ',
    promptVisibleLen: 2,
    slashRegistryView: { has: () => false },
  };
}

/** No-op repaint for unit tests that don't need to inspect output. */
const noop = () => {};

// ---------------------------------------------------------------------------
// createReverseSearchState
// ---------------------------------------------------------------------------

describe('createReverseSearchState', () => {
  it('returns an inactive state with empty query and -1 matchIndex', () => {
    const rs = createReverseSearchState();
    expect(rs.active).toBe(false);
    expect(rs.query).toBe('');
    expect(rs.matchIndex).toBe(-1);
    expect(rs.savedBuffer).toBe('');
  });
});

// ---------------------------------------------------------------------------
// enterReverseSearch
// ---------------------------------------------------------------------------

describe('enterReverseSearch', () => {
  it('activates the modal and saves the current buffer', () => {
    const rs = createReverseSearchState();
    const st = makeState('some draft');
    enterReverseSearch(rs, st);
    expect(rs.active).toBe(true);
    expect(rs.savedBuffer).toBe('some draft');
  });

  it('resets query and matchIndex on entry', () => {
    const rs = createReverseSearchState();
    rs.query = 'leftover';
    rs.matchIndex = 3;
    const st = makeState();
    enterReverseSearch(rs, st);
    expect(rs.query).toBe('');
    expect(rs.matchIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// cancelReverseSearch
// ---------------------------------------------------------------------------

describe('cancelReverseSearch', () => {
  it('deactivates the modal and restores the saved buffer', () => {
    const rs = createReverseSearchState();
    const st = makeState('original draft');
    enterReverseSearch(rs, st);
    // Simulate a match overwriting the buffer
    st.input = InputCore.seed('/different command');
    cancelReverseSearch(rs, st);
    expect(rs.active).toBe(false);
    expect(st.input.buffer).toBe('original draft');
  });
});

// ---------------------------------------------------------------------------
// acceptReverseSearch
// ---------------------------------------------------------------------------

describe('acceptReverseSearch', () => {
  it('deactivates the modal and keeps the current buffer', () => {
    const rs = createReverseSearchState();
    const st = makeState('initial');
    enterReverseSearch(rs, st);
    st.input = InputCore.seed('/matched command');
    acceptReverseSearch(rs, st);
    expect(rs.active).toBe(false);
    expect(st.input.buffer).toBe('/matched command');
  });
});

// ---------------------------------------------------------------------------
// findNextMatch
// ---------------------------------------------------------------------------

describe('findNextMatch', () => {
  const entries = ['/ship', '/mint foo', '/config', '/ship --dry-run', '/help'];

  it('returns -1 for an empty query', () => {
    expect(findNextMatch('', entries, -1)).toBe(-1);
  });

  it('returns -1 for empty entries', () => {
    expect(findNextMatch('ship', [], -1)).toBe(-1);
  });

  it('finds the first (newest) match from index -1', () => {
    expect(findNextMatch('ship', entries, -1)).toBe(0);
  });

  it('cycles to the next older match when called again', () => {
    const first = findNextMatch('ship', entries, -1);
    const second = findNextMatch('ship', entries, first);
    expect(second).toBe(3); // '/ship --dry-run' at index 3
  });

  it('returns -1 when no further match exists', () => {
    const idx = findNextMatch('ship', entries, 3);
    expect(idx).toBe(-1);
  });

  it('matches substrings (case-insensitive)', () => {
    expect(findNextMatch('CONFIG', entries, -1)).toBe(2);
  });

  it('returns -1 for a query with no matches', () => {
    expect(findNextMatch('zzz', entries, -1)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// renderReverseSearchLine
// ---------------------------------------------------------------------------

describe('renderReverseSearchLine', () => {
  it('renders the expected readline-style prompt', () => {
    expect(renderReverseSearchLine('ship', '/ship --dry-run')).toBe(
      "(reverse-i-search)`ship': /ship --dry-run",
    );
  });

  it('renders an empty match as an empty string', () => {
    expect(renderReverseSearchLine('xyz', null)).toBe("(reverse-i-search)`xyz': ");
  });

  it('renders an empty query', () => {
    expect(renderReverseSearchLine('', null)).toBe("(reverse-i-search)`': ");
  });
});

// ---------------------------------------------------------------------------
// handleReverseSearchKey
// ---------------------------------------------------------------------------

describe('handleReverseSearchKey', () => {
  const entries = ['/ship', '/mint foo', '/config', '/ship --dry-run'];

  function setup(initialBuffer = '') {
    const rs = createReverseSearchState();
    const st = makeState(initialBuffer);
    const ctx = makeRepaintCtx();
    enterReverseSearch(rs, st);
    return { rs, st, ctx };
  }

  it('Ctrl-R cycles to the next older match', () => {
    const { rs, st, ctx } = setup();
    // First: type 's' to get the first match
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    expect(rs.matchIndex).toBe(0);
    expect(st.input.buffer).toBe('/ship');

    // Ctrl-R: cycle to the next match
    const consumed = handleReverseSearchKey(undefined, { ctrl: true, name: 'r' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(true);
    expect(rs.matchIndex).toBe(3);
    expect(st.input.buffer).toBe('/ship --dry-run');
  });

  it('Esc cancels and restores the saved buffer', () => {
    const { rs, st, ctx } = setup('my draft');
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    const consumed = handleReverseSearchKey(undefined, { name: 'escape' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(true);
    expect(rs.active).toBe(false);
    expect(st.input.buffer).toBe('my draft');
  });

  it('Ctrl-G cancels and restores the saved buffer', () => {
    const { rs, st, ctx } = setup('my draft');
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    const consumed = handleReverseSearchKey(undefined, { ctrl: true, name: 'g' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(true);
    expect(rs.active).toBe(false);
    expect(st.input.buffer).toBe('my draft');
  });

  it('Enter accepts the match and returns false (fall-through)', () => {
    const { rs, st, ctx } = setup();
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    const consumed = handleReverseSearchKey(undefined, { name: 'return' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(false);
    expect(rs.active).toBe(false);
    expect(st.input.buffer).toBe('/ship');
  });

  it('Ctrl-C cancels and returns false (fall-through to abort)', () => {
    const { rs, st, ctx } = setup('saved');
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    const consumed = handleReverseSearchKey(undefined, { ctrl: true, name: 'c' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(false);
    expect(rs.active).toBe(false);
    // Buffer is restored to savedBuffer on Ctrl-C cancel
    expect(st.input.buffer).toBe('saved');
  });

  it('Backspace trims the query by one char and re-searches', () => {
    const { rs, st, ctx } = setup();
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    handleReverseSearchKey('h', { name: 'h' }, rs, st, entries, ctx, noop);
    expect(rs.query).toBe('sh');

    const consumed = handleReverseSearchKey(undefined, { name: 'backspace' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(true);
    expect(rs.query).toBe('s');
    // Still has a match for 's'
    expect(rs.matchIndex).toBeGreaterThanOrEqual(0);
  });

  it('Backspace on empty query restores the saved buffer', () => {
    const { rs, st, ctx } = setup('original');
    const consumed = handleReverseSearchKey(undefined, { name: 'backspace' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(true);
    expect(rs.query).toBe('');
    expect(st.input.buffer).toBe('original');
  });

  it('printable chars extend the query and update the match', () => {
    const { rs, st, ctx } = setup();
    const consumed = handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(true);
    expect(rs.query).toBe('s');
    expect(rs.matchIndex).toBe(0);
    expect(st.input.buffer).toBe('/ship');
  });

  it('printable chars with no match leave matchIndex as -1', () => {
    const { rs, st, ctx } = setup('saved');
    handleReverseSearchKey('z', { name: 'z' }, rs, st, entries, ctx, noop);
    expect(rs.query).toBe('z');
    expect(rs.matchIndex).toBe(-1);
  });

  it('unrecognised key (e.g. arrow) exits the modal and returns false', () => {
    const { rs, st, ctx } = setup();
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, noop);
    const consumed = handleReverseSearchKey(undefined, { name: 'up' }, rs, st, entries, ctx, noop);
    expect(consumed).toBe(false);
    expect(rs.active).toBe(false);
  });

  it('Ctrl-R with no history (empty entries) returns true and does nothing', () => {
    const { rs, st, ctx } = setup();
    const consumed = handleReverseSearchKey(undefined, { ctrl: true, name: 'r' }, rs, st, [], ctx, noop);
    expect(consumed).toBe(true);
    expect(rs.matchIndex).toBe(-1);
  });

  it('repaintFn is called on each key that modifies state', () => {
    const { rs, st, ctx } = setup();
    const repaint = vi.fn();
    handleReverseSearchKey('s', { name: 's' }, rs, st, entries, ctx, repaint);
    expect(repaint).toHaveBeenCalled();
  });
});
