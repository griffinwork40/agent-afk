/**
 * Unit tests for bash-output-viewer-model.ts
 *
 * Covers: scroll bounds, search navigation, missing/expired file, large-file
 * bounding, and sanitization of terminal escape sequences.
 *
 * @module cli/commands/interactive/bash-output-viewer-model.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  VIEWER_MAX_LINES,
  loadViewer,
  scrollUp,
  scrollDown,
  scrollHome,
  scrollEnd,
  applySearch,
  nextMatch,
  prevMatch,
  clearSearch,
  resize,
  maxScrollTop,
  _setConfinementRootForTest,
} from './bash-output-viewer-model.js';

// ---------------------------------------------------------------------------
// Filesystem setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-viewer-test-'));
  // Redirect confinement check to the per-test temp dir so tests don't
  // need to write into the real AFK witness state directory.
  _setConfinementRootForTest(tmpdir());
});

afterEach(() => {
  _setConfinementRootForTest(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeCapture(filename: string, content: string): string {
  const p = join(tmpDir, filename);
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// loadViewer — missing / expired
// ---------------------------------------------------------------------------

describe('loadViewer — missing file', () => {
  it('returns missing error when capturePath is undefined', () => {
    const result = loadViewer(undefined, 24);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('missing');
  });

  it('returns expired error for ENOENT path', () => {
    // Path must be inside the confinement root (tmpdir()) so the confinement
    // check passes and the ENOENT read triggers the 'expired' error.
    const result = loadViewer(join(tmpDir, 'no-such-file.txt'), 24);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// loadViewer — normal file
// ---------------------------------------------------------------------------

describe('loadViewer — normal file', () => {
  it('loads lines from file', () => {
    const p = writeCapture('out.txt', 'line1\nline2\nline3\n');
    const result = loadViewer(p, 24);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Trailing newline is stripped — exactly 3 content lines.
    expect(result.state.lines.length).toBe(3);
  });

  it('starts at tail (scrollTop near end) for default view', () => {
    const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const p = writeCapture('out.txt', content);
    const result = loadViewer(p, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // scrollTop should be near end, not 0
    expect(result.state.scrollTop).toBeGreaterThan(0);
  });

  it('totalLines matches line count', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    const p = writeCapture('out.txt', lines.join('\n'));
    const result = loadViewer(p, 24);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.totalLines).toBe(lines.length);
    expect(result.state.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadViewer — large file bounding
// ---------------------------------------------------------------------------

describe('loadViewer — large file bounding', () => {
  it('caps lines at VIEWER_MAX_LINES and sets truncated', () => {
    // Write VIEWER_MAX_LINES + 100 lines
    const bigContent = Array.from({ length: VIEWER_MAX_LINES + 100 }, (_, i) => `line${i}`).join('\n');
    const p = writeCapture('big.txt', bigContent);
    const result = loadViewer(p, 24);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // +1 for the elision notice appended after truncation
    expect(result.state.lines.length).toBe(VIEWER_MAX_LINES + 1);
    expect(result.state.truncated).toBe(true);
    expect(result.state.totalLines).toBe(VIEWER_MAX_LINES + 100);
    // Last line contains the elision notice
    const last = result.state.lines[result.state.lines.length - 1] ?? '';
    expect(last).toContain('100 lines elided');
  });
});

// ---------------------------------------------------------------------------
// loadViewer — sanitization
// ---------------------------------------------------------------------------

describe('loadViewer — sanitization', () => {
  it('strips ANSI CSI escape sequences', () => {
    const p = writeCapture('ansi.txt', '\x1b[31mred text\x1b[0m\nnormal');
    const result = loadViewer(p, 24);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allText = result.state.lines.join('\n');
    expect(allText).not.toContain('\x1b');
    expect(allText).toContain('red text');
    expect(allText).toContain('normal');
  });

  it('strips OSC-8 hyperlinks', () => {
    const p = writeCapture('osc.txt', '\x1b]8;;http://example.com\x07link\x1b]8;;\x07');
    const result = loadViewer(p, 24);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allText = result.state.lines.join('\n');
    expect(allText).not.toContain('\x1b');
    // The visible text "link" must survive
    expect(allText).toContain('link');
  });

  it('preserves newlines (does not collapse multi-line structure)', () => {
    const p = writeCapture('multi.txt', 'aaa\nbbb\nccc');
    const result = loadViewer(p, 24);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.lines.length).toBe(3);
    expect(result.state.lines[0]).toBe('aaa');
    expect(result.state.lines[1]).toBe('bbb');
  });
});

// ---------------------------------------------------------------------------
// Scroll bounds
// ---------------------------------------------------------------------------

describe('scroll bounds', () => {
  function makeState(lineCount: number, viewport: number) {
    const lines = Array.from({ length: lineCount }, (_, i) => `line${i}`);
    return {
      lines,
      truncated: false,
      totalLines: lineCount,
      scrollTop: 0,
      viewportRows: viewport,
      searchQuery: '',
      matchIndices: [] as readonly number[],
      matchCursor: -1,
    };
  }

  it('scrollDown clamps to maxScrollTop', () => {
    const state = makeState(20, 5);
    const moved = scrollDown(state, 1000);
    expect(moved.scrollTop).toBe(maxScrollTop(state));
  });

  it('scrollUp clamps to 0', () => {
    const state = { ...makeState(20, 5), scrollTop: 3 };
    const moved = scrollUp(state, 1000);
    expect(moved.scrollTop).toBe(0);
  });

  it('scrollHome reaches top', () => {
    const state = { ...makeState(20, 5), scrollTop: 10 };
    const homed = scrollHome(state);
    expect(homed.scrollTop).toBe(0);
  });

  it('scrollEnd reaches maxScrollTop', () => {
    const state = makeState(20, 5);
    const ended = scrollEnd(state);
    expect(ended.scrollTop).toBe(maxScrollTop(state));
  });

  it('maxScrollTop is 0 when lines fit in viewport', () => {
    const state = makeState(3, 10);
    expect(maxScrollTop(state)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('search', () => {
  function makeStateWithLines(lines: string[], viewport = 10) {
    return {
      lines,
      truncated: false,
      totalLines: lines.length,
      scrollTop: 0,
      viewportRows: viewport,
      searchQuery: '',
      matchIndices: [] as readonly number[],
      matchCursor: -1,
    };
  }

  it('applySearch finds case-insensitive matches', () => {
    const state = makeStateWithLines(['Hello World', 'foo', 'world tour', 'bar']);
    const s = applySearch(state, 'world');
    expect(s.matchIndices).toEqual([0, 2]);
    expect(s.matchCursor).toBe(0);
  });

  it('applySearch returns empty matchIndices for empty query', () => {
    const state = makeStateWithLines(['a', 'b', 'c']);
    const s = applySearch(state, '');
    expect(s.matchIndices).toHaveLength(0);
    expect(s.matchCursor).toBe(-1);
  });

  it('nextMatch wraps at end', () => {
    const state = makeStateWithLines(['a', 'match', 'b', 'match']);
    const s1 = applySearch(state, 'match');
    // cursor at 0 (first match)
    const s2 = nextMatch(s1);
    expect(s2.matchCursor).toBe(1);
    const s3 = nextMatch(s2);
    // wraps back to 0
    expect(s3.matchCursor).toBe(0);
  });

  it('prevMatch wraps at start', () => {
    const state = makeStateWithLines(['match', 'b', 'match', 'd']);
    const s1 = applySearch(state, 'match');
    // cursor at 0
    const s2 = prevMatch(s1);
    // wraps to last match index
    expect(s2.matchCursor).toBe(s1.matchIndices.length - 1);
  });

  it('clearSearch empties searchQuery and matchIndices', () => {
    const state = makeStateWithLines(['match', 'other']);
    const s1 = applySearch(state, 'match');
    const s2 = clearSearch(s1);
    expect(s2.searchQuery).toBe('');
    expect(s2.matchIndices).toHaveLength(0);
    expect(s2.matchCursor).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

describe('resize', () => {
  it('clamps scrollTop to new maxScrollTop', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
    const state = {
      lines,
      truncated: false,
      totalLines: 30,
      scrollTop: 25,
      viewportRows: 5,
      searchQuery: '',
      matchIndices: [] as readonly number[],
      matchCursor: -1,
    };
    // Make viewport bigger so max scrollTop decreases
    const s2 = resize(state, 28);
    expect(s2.scrollTop).toBeLessThanOrEqual(maxScrollTop(s2));
  });

  it('handles viewport of 1 without crashing', () => {
    const lines = ['a', 'b', 'c'];
    const state = {
      lines,
      truncated: false,
      totalLines: 3,
      scrollTop: 0,
      viewportRows: 10,
      searchQuery: '',
      matchIndices: [] as readonly number[],
      matchCursor: -1,
    };
    expect(() => resize(state, 1)).not.toThrow();
  });
});
