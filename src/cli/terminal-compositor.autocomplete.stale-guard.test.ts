/**
 * Stale-result guard for the async @-file dropdown scan.
 *
 * Contract: when a directory scan for query A resolves AFTER the user has
 * typed on to query B, A's candidates must be discarded — a late scan may
 * never repaint over a newer dropdown state. updateAutocomplete captures the
 * @-file query at dispatch time and, on resolve, applies candidates only when
 * the live trigger is still that exact query.
 *
 * We drive the guard deterministically by mocking `filterFileCandidatesAsync`
 * with hand-held deferred promises: dispatch A, dispatch B, then resolve A
 * last and assert A's result never lands. `filterFileCandidatesCached` is
 * forced to always miss so every keystroke takes the async path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candidate } from './input/types.js';

// Hoisted so the (also-hoisted) vi.mock factory below can close over the same
// deferred registry + spy the test body reads. A plain top-level `const` would
// be evaluated AFTER the hoisted factory and throw "cannot access before
// initialization".
const h = vi.hoisted(() => {
  interface Deferred {
    promise: Promise<Candidate[]>;
    resolve: (v: Candidate[]) => void;
  }
  const deferreds: Deferred[] = [];
  const asyncScan = vi.fn(() => {
    let resolve!: (v: Candidate[]) => void;
    const promise = new Promise<Candidate[]>((res) => { resolve = res; });
    deferreds.push({ promise, resolve });
    return promise;
  });
  return { deferreds, asyncScan };
});

vi.mock('./input/trigger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./input/trigger.js')>();
  return {
    ...actual,
    // Force every keystroke through the async path.
    filterFileCandidatesCached: () => null,
    filterFileCandidatesAsync: h.asyncScan,
  };
});

import { updateAutocomplete as update, type AutocompleteHost } from './terminal-compositor.autocomplete.js';
import { createAutocompleteState, type AutocompleteState } from './input/autocomplete-state.js';

function makeHost(ac: AutocompleteState, buffer: string, repaint: () => void): AutocompleteHost {
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

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  h.deferreds.length = 0;
  h.asyncScan.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('updateAutocomplete — stale @-file scan guard', () => {
  it('discards query A results that resolve AFTER query B was issued', async () => {
    const repaint = vi.fn();
    const ac = createAutocompleteState();

    // Keystroke 1: buffer is `@aa` — dispatch scan A (query "aa").
    const host = makeHost(ac, '@aa', repaint);
    update(host);
    expect(h.asyncScan).toHaveBeenCalledTimes(1);
    expect(h.asyncScan).toHaveBeenLastCalledWith('aa');

    // Keystroke 2: user types on so buffer is now `@bb` — dispatch scan B.
    // (Same host object; the input buffer advanced.)
    host.input = { buffer: '@bb', cursor: 3 };
    update(host);
    expect(h.asyncScan).toHaveBeenCalledTimes(2);
    expect(h.asyncScan).toHaveBeenLastCalledWith('bb');

    // Resolve B first with its candidates — the live trigger is "bb", so
    // these apply.
    h.deferreds[1]!.resolve([{ value: '@bbeta.ts' }]);
    await flush();
    expect(ac.candidates.map((c) => c.value)).toEqual(['@bbeta.ts']);
    const repaintsAfterB = repaint.mock.calls.length;

    // Now resolve the STALE scan A. Its query ("aa") no longer matches the
    // live trigger ("bb"), so its candidates must be dropped and NO repaint
    // fired.
    h.deferreds[0]!.resolve([{ value: '@aalpha.txt' }]);
    await flush();
    expect(ac.candidates.map((c) => c.value)).toEqual(['@bbeta.ts']);
    expect(repaint.mock.calls.length).toBe(repaintsAfterB);
  });

  it('applies a scan when its query is still the live trigger on resolve', async () => {
    const repaint = vi.fn();
    const ac = createAutocompleteState();
    const host = makeHost(ac, '@src', repaint);
    update(host);
    expect(h.asyncScan).toHaveBeenCalledTimes(1);

    // Buffer unchanged — resolve applies.
    h.deferreds[0]!.resolve([{ value: '@src/index.ts' }]);
    await flush();
    expect(ac.dropdownOpen).toBe(true);
    expect(ac.candidates.map((c) => c.value)).toEqual(['@src/index.ts']);
    expect(repaint).toHaveBeenCalledTimes(1);
  });
});
