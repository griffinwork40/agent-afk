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
 *
 * The @-file scan is async + cached (see trigger.ts). updateAutocomplete
 * serves a cache HIT synchronously and dispatches a cache MISS as a
 * fire-and-forget async scan whose result lands behind a stale guard. Tests
 * that assert on candidates therefore either (a) pre-warm the cache via
 * `filterFileCandidatesAsync` so the sync cache-hit path fills candidates
 * inline, or (b) drive a real host and flush microtasks to let the async
 * resolution apply.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateAutocomplete, type AutocompleteHost, MAX_DROPDOWN_ROWS } from './terminal-compositor.autocomplete.js';
import { createAutocompleteState, type AutocompleteState } from './input/autocomplete-state.js';
import {
  filterFileCandidatesAsync,
  invalidateFileScanCache,
} from './input/trigger.js';
import { MAX_FILE_MATCHES } from './multi-line-reader.js';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = join(tmpdir(), `afk-ac-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
  invalidateFileScanCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  invalidateFileScanCache();
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Minimal AutocompleteHost backed by a literal buffer/cursor. */
function makeHost(ac: AutocompleteState, buffer: string, repaint: () => void = () => {}): AutocompleteHost {
  return {
    autocompleteState: ac,
    input: { buffer, cursor: buffer.length },
    queued: false,
    activeGhost: null,
    ghostEngine: undefined,
    ghostGetContext: undefined,
    repaint,
  };
}

/**
 * Wait until `predicate` holds, polling across macro/microtask boundaries.
 * The @-file scan awaits a real `fs.promises.readdir`, which can take more
 * than one microtask tick to settle, so a single `setImmediate` flush is not
 * enough — poll (bounded) until the fire-and-forget resolution has applied.
 */
async function waitFor(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('updateAutocomplete — @-file branch (cache-warmed sync path)', () => {
  it('opens the dropdown with ALL matching files when more than 12 match (no re-cap to 12)', async () => {
    // 15 prefixed files — the count the old `.slice(0, 12)` would have hidden.
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(tmpRoot, `pick${String(i).padStart(2, '0')}.txt`), 'x');
    }
    process.chdir(tmpRoot);

    // Warm the per-directory cache so updateAutocomplete's sync cache-hit
    // path fills candidates inline (mirrors the steady-state keystroke where
    // the directory was already scanned on a prior keypress).
    await filterFileCandidatesAsync('pick');

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

  it('is bounded by MAX_FILE_MATCHES (the single upstream cap)', async () => {
    const total = MAX_FILE_MATCHES + 8;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(tmpRoot, `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    process.chdir(tmpRoot);
    await filterFileCandidatesAsync('f');

    const ac = createAutocompleteState();
    updateAutocomplete(makeHost(ac, '@f'));

    expect(ac.candidates).toHaveLength(MAX_FILE_MATCHES);
  });

  it('closes the dropdown when no file matches the prefix', async () => {
    writeFileSync(join(tmpRoot, 'readme.md'), 'x');
    process.chdir(tmpRoot);
    await filterFileCandidatesAsync('zzz');

    const ac = createAutocompleteState();
    updateAutocomplete(makeHost(ac, '@zzz'));

    expect(ac.dropdownOpen).toBe(false);
    expect(ac.candidates).toHaveLength(0);
  });
});

describe('updateAutocomplete — @-file branch (async resolution)', () => {
  it('populates candidates and repaints once the async scan resolves (cold cache)', async () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(tmpRoot, `pick${i}.txt`), 'x');
    }
    process.chdir(tmpRoot);

    const repaint = vi.fn();
    const ac = createAutocompleteState();
    // Cold cache: the sync path finds nothing, so the dropdown stays closed
    // synchronously and the scan is dispatched fire-and-forget.
    updateAutocomplete(makeHost(ac, '@pick', repaint));
    expect(ac.candidates).toHaveLength(0);
    expect(ac.dropdownOpen).toBe(false);
    expect(repaint).not.toHaveBeenCalled();

    // After the scan resolves, candidates apply and a repaint fires.
    await waitFor(() => ac.dropdownOpen);
    expect(ac.dropdownOpen).toBe(true);
    expect(ac.candidates).toHaveLength(3);
    expect(ac.candidates.every((c) => c.value.startsWith('@pick'))).toBe(true);
    expect(repaint).toHaveBeenCalled();
  });
});
