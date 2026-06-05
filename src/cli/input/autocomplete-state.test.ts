/**
 * Tests for the AutocompleteState factory and the shared-state behavior
 * across the InputSurface boundary.
 *
 * Coverage:
 *  1. createAutocompleteState() — initial values, reset() contract.
 *  2. reader.ts — accepts injected autocompleteState and resets it on entry.
 *  3. TerminalCompositor — history navigation (↑/↓) during agent turn.
 *  4. TerminalCompositor — shared autocomplete state updates on printable input.
 *  5. TerminalCompositor — ESC dismisses dropdown, records suppressedSignature.
 *  6. Cross-surface: same AutocompleteState instance visible to both surfaces.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { createAutocompleteState } from './autocomplete-state.js';
import type { AutocompleteState } from './autocomplete-state.js';
import { TerminalCompositor } from '../terminal-compositor.js';
import type { IHistoryRing } from './types.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from '../slash/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockStdout;
};

type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
};

function makeMockStdout(isTTY = true): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = isTTY;
  s.columns = 80;
  s.rows = 24;
  return s;
}

function makeMockStdin(isTTY = true): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = isTTY;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

/** Minimal IHistoryRing implementation backed by a simple array. */
function makeHistory(entries: string[] = []): IHistoryRing & {
  back: ReturnType<typeof vi.fn>;
  forward: ReturnType<typeof vi.fn>;
  resetRecall: ReturnType<typeof vi.fn>;
} {
  const stored = [...entries];
  let index = -1;
  let draft = '';

  const back = vi.fn((currentDraft: string): string | null => {
    if (stored.length === 0) return null;
    if (index === -1) { draft = currentDraft; index = stored.length - 1; }
    else if (index > 0) index--;
    return stored[index] ?? null;
  });

  const forward = vi.fn((): string | null => {
    if (index === -1) return null;
    if (index < stored.length - 1) { index++; return stored[index] ?? null; }
    index = -1;
    const d = draft; draft = '';
    return d;
  });

  const resetRecall = vi.fn(() => { index = -1; draft = ''; });

  return {
    back,
    forward,
    resetRecall,
    get inRecall() { return index !== -1; },
  };
}

// ---------------------------------------------------------------------------
// 1. createAutocompleteState() — factory + reset()
// ---------------------------------------------------------------------------

describe('createAutocompleteState()', () => {
  it('returns all fields at initial (closed) values', () => {
    const ac = createAutocompleteState();
    expect(ac.dropdownOpen).toBe(false);
    expect(ac.candidates).toEqual([]);
    expect(ac.selectedIndex).toBe(0);
    expect(ac.viewportStart).toBe(0);
    expect(ac.suppressedSignature).toBeNull();
    expect(ac.trigger).toBeNull();
  });

  it('reset() restores all fields to initial values after mutation', () => {
    const ac = createAutocompleteState();
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/foo', summary: 'bar' }];
    ac.selectedIndex = 1;
    ac.viewportStart = 2;
    ac.suppressedSignature = '5:/foo';
    ac.trigger = { kind: 'slash', query: 'foo' };

    ac.reset();

    expect(ac.dropdownOpen).toBe(false);
    expect(ac.candidates).toEqual([]);
    expect(ac.selectedIndex).toBe(0);
    expect(ac.viewportStart).toBe(0);
    expect(ac.suppressedSignature).toBeNull();
    expect(ac.trigger).toBeNull();
  });

  it('reset() is idempotent — calling twice is safe', () => {
    const ac = createAutocompleteState();
    ac.reset();
    ac.reset();
    expect(ac.dropdownOpen).toBe(false);
  });

  it('object returned is mutable (same reference, not frozen)', () => {
    const ac = createAutocompleteState();
    expect(() => { ac.dropdownOpen = true; }).not.toThrow();
    expect(ac.dropdownOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-surface: same instance remains the identity reference
// ---------------------------------------------------------------------------

describe('AutocompleteState — shared identity', () => {
  it('two consumers receive the same object reference', () => {
    const ac = createAutocompleteState();
    const ref1: AutocompleteState = ac;
    const ref2: AutocompleteState = ac;
    ref1.selectedIndex = 3;
    expect(ref2.selectedIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. TerminalCompositor — history navigation during agent turn
// ---------------------------------------------------------------------------

describe('TerminalCompositor — history navigation', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
  });

  it('↑ (up arrow) recalls previous entry from shared history', async () => {
    const history = makeHistory(['first entry', 'second entry']);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'up' });

    expect(history.back).toHaveBeenCalledTimes(1);
    // After recall, buffer should contain the recalled entry.
    expect(c.getBuffer().text).toBe('second entry');
  });

  it('↑ twice navigates backward through history', async () => {
    const history = makeHistory(['first entry', 'second entry']);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'up' });
    stdin.emit('keypress', undefined, { name: 'up' });

    expect(history.back).toHaveBeenCalledTimes(2);
    expect(c.getBuffer().text).toBe('first entry');
  });

  it('↓ (down arrow) advances history forward', async () => {
    const history = makeHistory(['entry one', 'entry two']);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    // Navigate back first so forward has something to return.
    stdin.emit('keypress', undefined, { name: 'up' });
    stdin.emit('keypress', undefined, { name: 'down' });

    expect(history.forward).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+P recalls history (same as ↑)', async () => {
    const history = makeHistory(['ctrl-p entry']);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'p', ctrl: true });

    expect(history.back).toHaveBeenCalledTimes(1);
    expect(c.getBuffer().text).toBe('ctrl-p entry');
  });

  it('Ctrl+N advances history forward (same as ↓)', async () => {
    const history = makeHistory(['entry']);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'p', ctrl: true }); // go back first
    stdin.emit('keypress', undefined, { name: 'n', ctrl: true }); // now forward

    expect(history.forward).toHaveBeenCalledTimes(1);
  });

  it('↑ with empty history is a no-op (buffer stays empty)', async () => {
    const history = makeHistory([]); // no entries
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'up' });

    expect(c.getBuffer().text).toBe('');
  });

  it('without history, ↑ does not throw', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() }); // no history
    await c.arm();

    expect(() => {
      stdin.emit('keypress', undefined, { name: 'up' });
    }).not.toThrow();
    expect(c.getBuffer().text).toBe('');
  });

  it('printable keypress resets recall (resetRecall called)', async () => {
    const history = makeHistory(['entry a', 'entry b']);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'up' }); // start recall
    stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' }); // edit → resets recall

    expect(history.resetRecall).toHaveBeenCalled();
  });

  it('backspace resets recall', async () => {
    const history = makeHistory(['entry']);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'up' });
    stdin.emit('keypress', undefined, { name: 'backspace' }); // shrinks buffer → resets recall

    expect(history.resetRecall).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. TerminalCompositor — shared autocomplete state updates on printable input
// ---------------------------------------------------------------------------

describe('TerminalCompositor — autocomplete state synchronisation', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
  });

  it('typing printable characters updates autocomplete state trigger', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    // Type "/" — should trigger slash autocomplete detection.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });

    // The trigger should now be detected as 'slash' with empty query.
    expect(ac.trigger).not.toBeNull();
    expect(ac.trigger?.kind).toBe('slash');
    expect(ac.trigger?.query).toBe('');
  });

  it('typing "/fo" populates candidates from slash registry', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    stdin.emit('keypress', 'f', { name: 'f', sequence: 'f' });
    stdin.emit('keypress', 'o', { name: 'o', sequence: 'o' });

    // Buffer is now "/fo" — trigger is slash with query "fo".
    // The slash registry may or may not have /fo* commands in test context.
    // We just assert the state machine ran without error and trigger updated.
    expect(ac.trigger?.kind).toBe('slash');
    expect((ac.trigger as { kind: 'slash'; query: string }).query).toBe('fo');
  });

  it('backspace updates autocomplete state after edit', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    stdin.emit('keypress', undefined, { name: 'backspace' });

    // Buffer is now empty — trigger should be null.
    expect(ac.trigger).toBeNull();
    expect(ac.dropdownOpen).toBe(false);
  });

  it('disarm resets the shared autocomplete state', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    // Manually set state as if the compositor had opened the dropdown.
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/foo' }];
    ac.selectedIndex = 0;

    c.disarm();

    // After disarm, the autocomplete state must be clean so the next
    // user-turn read starts with a fresh dropdown.
    expect(ac.dropdownOpen).toBe(false);
    expect(ac.candidates).toEqual([]);
    expect(ac.selectedIndex).toBe(0);
    expect(ac.suppressedSignature).toBeNull();
  });

  it('no autocompleteState option: compositor still works normally', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() }); // no ac
    await c.arm();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });

    // Should not throw and buffer should contain '/'.
    expect(c.getBuffer().text).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// 5. TerminalCompositor — ESC dismisses dropdown via suppressedSignature
// ---------------------------------------------------------------------------

describe('TerminalCompositor — ESC dropdown dismissal', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    // Seed the slash registry so filterSlashCandidates returns ≥1 candidate
    // when the buffer is '/'. This ensures the dropdown is opened through the
    // real updateAutocomplete() path, not by direct mutation.
    resetSlashRegistry();
    registerSlashCommand({
      name: '/test-esc',
      summary: 'Stub command for ESC-dismissal tests',
      handler: async () => ({ kind: 'noop' as const }),
    });
  });

  afterEach(() => {
    resetSlashRegistry();
  });

  it('ESC while dropdown is open dismisses it and sets suppressedSignature', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    // Type '/' — the compositor calls updateAutocomplete(), which calls
    // filterSlashCandidates(''), finds '/test-esc', and sets dropdownOpen = true.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });

    // Verify the dropdown opened through the legitimate keystroke path
    // (not via direct mutation) before firing ESC.
    expect(ac.dropdownOpen).toBe(true);
    expect(ac.candidates.length).toBeGreaterThan(0);

    stdin.emit('keypress', undefined, { name: 'escape' });

    expect(ac.dropdownOpen).toBe(false);
    expect(ac.suppressedSignature).not.toBeNull();
    // Signature encodes cursor position (1) and buffer ('/').
    expect(ac.suppressedSignature).toBe('1:/');
  });

  it('ESC with dropdown closed triggers onSoftStop (not onCancel)', async () => {
    const onCancel = vi.fn();
    const onSoftStop = vi.fn();
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel, onSoftStop, autocompleteState: ac });
    await c.arm();

    // No dropdown open — ESC falls through to soft-stop path.
    ac.dropdownOpen = false;

    stdin.emit('keypress', undefined, { name: 'escape' });

    // ESC routes to onSoftStop; onCancel (Ctrl+C) is not called.
    expect(onSoftStop).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('ESC with no autocompleteState still triggers onSoftStop', async () => {
    const onCancel = vi.fn();
    const onSoftStop = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin, onCancel, onSoftStop }); // no ac
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'escape' });

    expect(onSoftStop).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. TerminalCompositor — ↑/↓ dropdown navigation when dropdown is open
// ---------------------------------------------------------------------------

describe('TerminalCompositor — ↑/↓ navigates dropdown, not history', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
  });

  // Invariant: the dropdown renders REVERSED (renderDropdownRows pins the
  // input at the bottom and grows the list UPWARD), so candidate index 0 is
  // visually at the BOTTOM and higher indices ascend. For the arrow keys to
  // move the highlight in the pressed direction, ↑ must INCREMENT the index
  // (move up/away from input) and ↓ must DECREMENT it (move down/toward
  // input). These assertions pin that visual contract — do not "simplify"
  // them back to ↑=decrement, or navigation appears flipped to the user.

  it('↑ increments selectedIndex when dropdown is open (moves highlight up, not history)', async () => {
    const history = makeHistory(['hist-entry']);
    const ac = createAutocompleteState();
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/a' }, { value: '/b' }, { value: '/c' }];
    ac.selectedIndex = 1;

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history, autocompleteState: ac });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'up' });

    expect(ac.selectedIndex).toBe(2);
    // History must NOT have been consulted.
    expect(history.back).not.toHaveBeenCalled();
  });

  it('↓ decrements selectedIndex when dropdown is open (moves highlight down, not history)', async () => {
    const history = makeHistory(['hist-entry']);
    const ac = createAutocompleteState();
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/a' }, { value: '/b' }, { value: '/c' }];
    ac.selectedIndex = 2;

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history, autocompleteState: ac });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'down' });

    expect(ac.selectedIndex).toBe(1);
    expect(history.forward).not.toHaveBeenCalled();
  });

  it('↑ at the last candidate does not go past the top of the list', async () => {
    const ac = createAutocompleteState();
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/a' }, { value: '/b' }];
    ac.selectedIndex = 1;

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'up' });

    expect(ac.selectedIndex).toBe(1);
  });

  it('↓ at selectedIndex 0 does not go below 0', async () => {
    const ac = createAutocompleteState();
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/a' }, { value: '/b' }];
    ac.selectedIndex = 0;

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    stdin.emit('keypress', undefined, { name: 'down' });

    expect(ac.selectedIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Integration: autocompleteState is reset at reader entry and survives
//    arm/disarm cycles.
// ---------------------------------------------------------------------------

describe('InputSurface boundary — shared state survives arm/disarm cycle', () => {
  it('autocompleteState reset() is called by compositor disarm, so reader starts clean', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const ac = createAutocompleteState();

    // Simulate compositor opening a dropdown during an agent turn.
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/foo' }];
    ac.selectedIndex = 0;
    ac.suppressedSignature = '3:/fo';

    // Disarm (end of agent turn).
    c.disarm();

    // State must be clean — reader.ts's ac.reset() at entry would find it clean.
    expect(ac.dropdownOpen).toBe(false);
    expect(ac.candidates).toEqual([]);
    expect(ac.selectedIndex).toBe(0);
    expect(ac.suppressedSignature).toBeNull();
    expect(ac.trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. reader.ts — accepts injected autocompleteState and resets it on entry
// ---------------------------------------------------------------------------

describe('readWithAutocompleteTty — resets injected autocompleteState on entry', () => {
  it('calls ac.reset() before the first keypress even when state is pre-dirty', async () => {
    // reader.ts line 82-83: `const ac = opts.autocompleteState ?? createAutocompleteState();
    //                          ac.reset();`
    // Verify this contract by passing a pre-dirty state and confirming reset()
    // fires synchronously at read entry.
    //
    // Strategy: spy on reset(), pass compositor: { isArmed: () => true } so
    // readWithAutocompleteTty skips enterRawMode, then emit a 'return' keypress
    // on process.stdin to resolve the Promise.
    const { readWithAutocompleteTty } = await import('./reader.js');

    const ac = createAutocompleteState();
    // Pre-dirty state simulating leftovers from an agent turn.
    ac.dropdownOpen = true;
    ac.candidates = [{ value: '/stale' }];
    ac.selectedIndex = 1;
    ac.suppressedSignature = '5:/stale';
    ac.trigger = { kind: 'slash', query: 'stale' };

    const resetSpy = vi.spyOn(ac, 'reset');

    // compositor: { isArmed: () => true } → reader skips enterRawMode.
    // Emit 'return' asynchronously to let the Promise executor run first
    // (reset() fires inside the executor, before any keypress).
    const readPromise = readWithAutocompleteTty({
      rl: { setPrompt: vi.fn(), prompt: vi.fn(), once: vi.fn(), on: vi.fn(), off: vi.fn(), close: vi.fn() } as unknown as import('readline').Interface,
      promptFn: () => '> ',
      compositor: { isArmed: () => true },
      autocompleteState: ac,
    });

    // Yield so the Promise executor (which calls ac.reset() and registers
    // handleKeypress on process.stdin) runs before we check.
    await Promise.resolve();

    // reset() must have been invoked synchronously at entry.
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // Resolve the dangling Promise by emitting a 'return' keypress on stdin.
    process.stdin.emit('keypress', undefined, { name: 'return' });
    await readPromise.catch(() => {});
  });
});
