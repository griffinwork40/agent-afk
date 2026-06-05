/**
 * Tests for updateAutocomplete — the compositor-layer call site that feeds
 * the @-file dropdown.
 *
 * Coverage gap this closes: the data-layer caps (fileMatchesFor,
 * filterFileCandidates) are unit-tested in multi-line-reader.test.ts and
 * input/trigger.test.ts, but the compositor's own file branch used to re-cap
 * candidates to 12. This drives the real keystroke→cwd path through
 * updateAutocomplete to prove the dropdown surfaces >12 file candidates and
 * scrolls, rather than silently truncating.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateAutocomplete, type AutocompleteHost, MAX_DROPDOWN_ROWS } from './terminal-compositor.autocomplete.js';
import { createAutocompleteState, type AutocompleteState } from './input/autocomplete-state.js';
import { MAX_FILE_MATCHES } from './multi-line-reader.js';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = join(tmpdir(), `afk-ac-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Minimal AutocompleteHost backed by a literal buffer/cursor. */
function makeHost(ac: AutocompleteState, buffer: string): AutocompleteHost {
  return {
    autocompleteState: ac,
    input: { buffer, cursor: buffer.length },
    queued: false,
    activeGhost: null,
    ghostEngine: undefined,
    ghostGetContext: undefined,
    repaint: () => {},
  };
}

describe('updateAutocomplete — @-file branch', () => {
  it('opens the dropdown with ALL matching files when more than 12 match (no re-cap to 12)', () => {
    // 15 prefixed files — the count the old `.slice(0, 12)` would have hidden.
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(tmpRoot, `pick${String(i).padStart(2, '0')}.txt`), 'x');
    }
    process.chdir(tmpRoot);

    const ac = createAutocompleteState();
    updateAutocomplete(makeHost(ac, '@pick'));

    expect(ac.dropdownOpen).toBe(true);
    expect(ac.candidates).toHaveLength(15);
    expect(ac.candidates.every((c) => c.value.startsWith('@pick'))).toBe(true);
    // Viewport opens at the top; only MAX_DROPDOWN_ROWS are visible at once,
    // but the remaining candidates are reachable by scrolling.
    expect(ac.selectedIndex).toBe(0);
    expect(ac.viewportStart).toBe(0);
    expect(ac.candidates.length).toBeGreaterThan(MAX_DROPDOWN_ROWS);
  });

  it('is bounded by MAX_FILE_MATCHES (the single upstream cap)', () => {
    const total = MAX_FILE_MATCHES + 8;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(tmpRoot, `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    process.chdir(tmpRoot);

    const ac = createAutocompleteState();
    updateAutocomplete(makeHost(ac, '@f'));

    expect(ac.candidates).toHaveLength(MAX_FILE_MATCHES);
  });

  it('closes the dropdown when no file matches the prefix', () => {
    writeFileSync(join(tmpRoot, 'readme.md'), 'x');
    process.chdir(tmpRoot);

    const ac = createAutocompleteState();
    updateAutocomplete(makeHost(ac, '@zzz'));

    expect(ac.dropdownOpen).toBe(false);
    expect(ac.candidates).toHaveLength(0);
  });
});
