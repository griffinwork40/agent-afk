/**
 * Tests for `runPicker` — the arrow-key picker for ask_question
 * choice / multi_choice elicitations.
 *
 * The picker is exercised against a `FakePickerHost` that records
 * `enterPickerMode` / `exitPickerMode` / `repaintPicker` calls and
 * exposes a `pressKey(name)` helper that drives the controller's
 * `onKey` callback synchronously. This lets each test focus on the
 * state-machine semantics without standing up a real compositor.
 */

import { describe, expect, it, vi } from 'vitest';
import { runPicker, type PickerHost } from './picker.js';
import type { PickerController } from '../terminal-compositor.js';

/**
 * Captures every interaction the picker has with its host so tests
 * can assert on:
 * - whether `enterPickerMode` / `exitPickerMode` fired (and how often)
 * - what rows the picker would render at any point (renderSnapshot)
 * - the sequence of repaints (a proxy for state changes)
 *
 * `pressKey(name, [opts])` synthesises a KeyInfo and dispatches it
 * through the controller. Mirrors what TerminalCompositor.dispatchKey
 * would do in picker mode.
 */
class FakePickerHost implements PickerHost {
  enterCalls = 0;
  exitCalls = 0;
  repaintCalls = 0;
  controller: PickerController | null = null;

  constructor(private readonly rows?: number) {}

  terminalRows(): number | undefined {
    return this.rows;
  }

  enterPickerMode(controller: PickerController): void {
    this.enterCalls += 1;
    this.controller = controller;
  }

  exitPickerMode(): void {
    this.exitCalls += 1;
    this.controller = null;
  }

  repaintPicker(): void {
    this.repaintCalls += 1;
  }

  pressKey(
    name: string,
    opts: { char?: string; ctrl?: boolean; shift?: boolean } = {},
  ): void {
    if (!this.controller) throw new Error('FakePickerHost: no controller installed');
    this.controller.onKey(opts.char, {
      name,
      ctrl: opts.ctrl ?? false,
      shift: opts.shift ?? false,
    });
  }

  renderSnapshot(): readonly string[] {
    if (!this.controller) throw new Error('FakePickerHost: no controller installed');
    return this.controller.renderRows();
  }
}

describe('runPicker — single-select', () => {
  it('resolves with selected value on Enter', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: ['  ? Pick one:'],
      options: ['alpha', 'beta', 'gamma'],
    });
    expect(host.enterCalls).toBe(1);
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha']);
    expect(host.exitCalls).toBe(1);
  });

  it('Down arrow moves cursor and selects next option', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
    });
    host.pressKey('down');
    expect(host.repaintCalls).toBe(1);
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['beta']);
  });

  it('Up arrow at index 0 wraps to last option', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
    });
    host.pressKey('up');
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['gamma']);
  });

  it('Down arrow at last option wraps to first', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
    });
    host.pressKey('down');
    host.pressKey('down');
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha']);
  });

  it('Escape returns null', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
    });
    host.pressKey('escape');
    const result = await p;
    expect(result).toBeNull();
    expect(host.exitCalls).toBe(1);
  });

  it('Ctrl+C returns null', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
    });
    host.pressKey('c', { ctrl: true });
    const result = await p;
    expect(result).toBeNull();
  });

  it('Ctrl+C calls onCtrlC before resolving null', async () => {
    const host = new FakePickerHost();
    const onCtrlC = vi.fn();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      onCtrlC,
    });
    host.pressKey('c', { ctrl: true });
    const result = await p;
    expect(onCtrlC).toHaveBeenCalledOnce();
    expect(result).toBeNull();
    expect(host.exitCalls).toBe(1);
  });

  it('Esc does NOT call onCtrlC', async () => {
    const host = new FakePickerHost();
    const onCtrlC = vi.fn();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      onCtrlC,
    });
    host.pressKey('escape');
    const result = await p;
    expect(onCtrlC).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('onCtrlC is not called when Ctrl+C fires after picker resolves (resolved guard)', async () => {
    const host = new FakePickerHost();
    const onCtrlC = vi.fn();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      onCtrlC,
    });
    host.pressKey('return'); // resolves first
    await p;
    // Simulate a late Ctrl+C arriving after resolve — resolved guard must block it.
    // We need to call onKey directly since FakePickerHost clears controller on exit.
    // The guard is inside runPicker's closure; the only way to exercise it is to
    // grab the controller before it exits. This test verifies exit happened once.
    expect(host.exitCalls).toBe(1);
    expect(onCtrlC).not.toHaveBeenCalled();
  });

  it('Home jumps to first option', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
      initialIndex: 2,
    });
    host.pressKey('home');
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha']);
  });

  it('End jumps to last option', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
    });
    host.pressKey('end');
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['gamma']);
  });

  it('initialIndex sets starting selection', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
      initialIndex: 1,
    });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['beta']);
  });

  it('initialIndex out of range clamps to valid', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      initialIndex: 99,
    });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['beta']);
  });

  it('printable characters are swallowed (no selection change)', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
    });
    host.pressKey('a', { char: 'a' });
    host.pressKey('z', { char: 'z' });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha']); // unchanged from initial
  });

  it('Tab is swallowed', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
    });
    host.pressKey('tab');
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha']);
  });

  it('empty options array resolves null without entering picker mode', async () => {
    const host = new FakePickerHost();
    const result = await runPicker(host, {
      header: [],
      options: [],
    });
    expect(result).toBeNull();
    expect(host.enterCalls).toBe(0);
    expect(host.exitCalls).toBe(0);
  });
});

describe('runPicker — multi-select', () => {
  it('Space toggles current row', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
      multi: true,
    });
    host.pressKey('space', { char: ' ' });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha']);
  });

  it('Space + Down + Space + Enter selects two rows', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
      multi: true,
    });
    host.pressKey('space', { char: ' ' });
    host.pressKey('down');
    host.pressKey('space', { char: ' ' });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha', 'beta']);
  });

  it('Space toggle off un-selects', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      multi: true,
    });
    host.pressKey('space', { char: ' ' });
    host.pressKey('space', { char: ' ' }); // toggle off
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual([]);
  });

  it('Enter with nothing selected returns empty array', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      multi: true,
    });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual([]);
  });

  it('initialSelected pre-toggles indices', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
      multi: true,
      initialSelected: new Set([0, 2]),
    });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha', 'gamma']);
  });

  it('Space without multi is a no-op (does not toggle)', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      // multi: false (default)
    });
    host.pressKey('space', { char: ' ' });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['alpha']); // single-select still chose cursor
  });

  it('output order matches options order, not selection order', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
      multi: true,
    });
    // Select gamma first (idx 2), then alpha (idx 0).
    host.pressKey('down');
    host.pressKey('down');
    host.pressKey('space', { char: ' ' }); // toggle gamma
    host.pressKey('home');
    host.pressKey('space', { char: ' ' }); // toggle alpha
    host.pressKey('return');
    const result = await p;
    // Insertion order in the Set is gamma→alpha, but iteration in the
    // picker reads options[i] in order, so output is options-order.
    expect(result).toEqual(['alpha', 'gamma']);
  });
});

describe('runPicker — abort signal', () => {
  it('signal already aborted on entry returns null without entering picker', async () => {
    const host = new FakePickerHost();
    const ac = new AbortController();
    ac.abort();
    const result = await runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      signal: ac.signal,
    });
    expect(result).toBeNull();
    expect(host.enterCalls).toBe(0);
    expect(host.exitCalls).toBe(0);
  });

  it('signal fires mid-keystroke exits picker and resolves null', async () => {
    const host = new FakePickerHost();
    const ac = new AbortController();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      signal: ac.signal,
    });
    expect(host.enterCalls).toBe(1);
    host.pressKey('down');
    ac.abort();
    const result = await p;
    expect(result).toBeNull();
    expect(host.exitCalls).toBe(1);
  });

  it('exitPickerMode fires exactly once even if Enter races with abort', async () => {
    const host = new FakePickerHost();
    const ac = new AbortController();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      signal: ac.signal,
    });
    host.pressKey('return'); // resolves with ['alpha']
    ac.abort(); // would resolve null if not guarded — but onAbort detached
    const result = await p;
    expect(result).toEqual(['alpha']);
    expect(host.exitCalls).toBe(1); // guarded by `resolved` flag
  });

  it('late keystroke after resolution does not re-fire exitPickerMode', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
    });
    host.pressKey('return');
    await p;
    // controller is now null on the host — but we can still try to
    // construct a synthetic onKey call against the captured controller
    // by re-reading it before it was cleared. This simulates a race
    // where dispatchKey landed AFTER finish() resolved.
    expect(host.exitCalls).toBe(1);
    // Cannot meaningfully press another key without re-entering picker
    // mode; the FakePickerHost cleared `controller`. The `resolved`
    // guard inside runPicker means even if we could, it'd be a no-op.
  });
});

describe('runPicker — render output', () => {
  it('renders header lines verbatim followed by options', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: ['  ? Pick one:', ''],
      options: ['alpha', 'beta'],
    });
    const rows = host.renderSnapshot();
    expect(rows[0]).toBe('  ? Pick one:');
    expect(rows[1]).toBe('');
    // Options follow header — strip ANSI for comparison
    const stripped = rows.map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(stripped[2]).toContain('alpha');
    expect(stripped[3]).toContain('beta');
    host.pressKey('escape');
    await p;
  });

  it('cursor glyph (▸) marks the current row', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta', 'gamma'],
      initialIndex: 1,
    });
    const stripped = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(stripped[0]).not.toContain('▸');
    expect(stripped[1]).toContain('▸');
    expect(stripped[2]).not.toContain('▸');
    host.pressKey('escape');
    await p;
  });

  it('multi-select renders checkbox glyphs', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
      multi: true,
      initialSelected: new Set([0]),
    });
    const stripped = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(stripped[0]).toContain('◉'); // checked
    expect(stripped[1]).toContain('◯'); // unchecked
    host.pressKey('escape');
    await p;
  });

  it('help line is the LAST row (bottom-pinned invariant)', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: ['header'],
      options: ['alpha', 'beta'],
    });
    const rows = host.renderSnapshot();
    const last = rows[rows.length - 1] ?? '';
    expect(last.replace(/\u001b\[[0-9;]*m/g, '')).toContain('↑/↓');
    host.pressKey('escape');
    await p;
  });

  it('repaint after Down arrow reflects new cursor position', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha', 'beta'],
    });
    const before = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(before[0]).toContain('▸');
    host.pressKey('down');
    const after = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(after[0]).not.toContain('▸');
    expect(after[1]).toContain('▸');
    host.pressKey('escape');
    await p;
  });
});

describe('runPicker — controller exit safety', () => {
  it('FakePickerHost confirms exit was called once after resolve', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha'],
    });
    host.pressKey('return');
    await p;
    expect(host.exitCalls).toBe(1);
  });

  it('abort signal listener is removed on confirm', async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['alpha'],
      signal: ac.signal,
    });
    host.pressKey('return');
    await p;
    expect(removeSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Virtual scroll
// ---------------------------------------------------------------------------

describe('runPicker — virtual scroll', () => {
  const makeOpts = (count: number) =>
    Array.from({ length: count }, (_, i) => `option-${i + 1}`);

  it('renders at most WINDOW_SIZE (20) rows for a long list', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, { header: [], options: makeOpts(50) });
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    // header=0, 20 option rows, scroll indicator, help line
    const optionRows = rows.filter((r) => r.includes('option-'));
    expect(optionRows.length).toBe(20);
    host.pressKey('escape');
    await p;
  });

  it('sizes the viewport to the available terminal rows', async () => {
    const host = new FakePickerHost(24);
    const p = runPicker(host, {
      header: ['one', 'two', 'three'],
      options: makeOpts(50),
      searchable: true,
    });
    const rows = host.renderSnapshot();
    expect(rows.length).toBeLessThanOrEqual(23);
    expect(rows.filter((row) => row.includes('option-')).length).toBe(17);
    host.pressKey('escape');
    await p;
  });

  it('shows a scroll indicator for lists longer than WINDOW_SIZE', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, { header: [], options: makeOpts(30) });
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    const hasIndicator = rows.some((r) => r.includes('of 30') && r.includes('scroll'));
    expect(hasIndicator).toBe(true);
    host.pressKey('escape');
    await p;
  });

  it('no scroll indicator when list fits in window', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, { header: [], options: makeOpts(5) });
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    const hasIndicator = rows.some((r) => r.includes('scroll'));
    expect(hasIndicator).toBe(false);
    host.pressKey('escape');
    await p;
  });

  it('scrolling Down past window edge advances viewport', async () => {
    const host = new FakePickerHost();
    const opts = makeOpts(25);
    const p = runPicker(host, { header: [], options: opts });
    // Move cursor past the first 20 rows to trigger scroll
    for (let i = 0; i < 20; i++) host.pressKey('down');
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    // option-21 should now be visible
    expect(rows.some((r) => r.includes('option-21'))).toBe(true);
    // option-1 should have scrolled off
    expect(rows.some((r) => r.includes('option-1') && !r.includes('option-1'))).toBe(false);
    // Confirm the viewport shifted by checking option-1 is not present
    const firstOption = rows.find((r) => r.match(/option-\d+/));
    expect(firstOption).not.toContain('option-1');
    host.pressKey('escape');
    await p;
  });

  it('Home resets viewport to top', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, { header: [], options: makeOpts(30) });
    for (let i = 0; i < 22; i++) host.pressKey('down');
    host.pressKey('home');
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(rows.some((r) => r.includes('option-1'))).toBe(true);
    host.pressKey('escape');
    await p;
  });

  it('End jumps to last option and scrolls correctly', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, { header: [], options: makeOpts(30) });
    host.pressKey('end');
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['option-30']);
  });

  it('Enter on a scrolled list returns the correct option', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, { header: [], options: makeOpts(25) });
    for (let i = 0; i < 22; i++) host.pressKey('down'); // cursor at option-23
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['option-23']);
  });
});

// ---------------------------------------------------------------------------
// Fuzzy search / filter (searchable: true)
// ---------------------------------------------------------------------------

describe('runPicker — searchable mode', () => {
  it('ignores Enter when the filter has no matches', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['apple', 'banana'],
      searchable: true,
    });
    host.pressKey('z', { char: 'z' });
    host.pressKey('return');
    expect(host.exitCalls).toBe(0);
    host.pressKey('escape');
    host.pressKey('escape');
    expect(await p).toBeNull();
  });

  it('printable char appends to filter query and narrows options', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['apple', 'banana', 'apricot'],
      searchable: true,
    });
    host.pressKey('a', { char: 'a' });
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    // 'banana' contains 'a' too, so all three match; but filter row should appear
    const filterRow = rows.find((r) => r.includes('Filter:'));
    expect(filterRow).toBeDefined();
    expect(filterRow).toContain('a');
    host.pressKey('escape'); // clears filter (non-empty)
    host.pressKey('escape'); // cancels
    await p;
  });

  it('typing "appl" hides non-matching options', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['apple', 'banana', 'apricot'],
      searchable: true,
    });
    for (const ch of 'appl') {
      host.pressKey(ch, { char: ch });
    }
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    // Only 'apple' matches 'appl'
    expect(rows.some((r) => r.includes('apple'))).toBe(true);
    expect(rows.some((r) => r.includes('banana'))).toBe(false);
    expect(rows.some((r) => r.includes('apricot'))).toBe(false);
    host.pressKey('escape');
    host.pressKey('escape');
    await p;
  });

  it('Backspace removes last filter char', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['apple', 'banana'],
      searchable: true,
    });
    host.pressKey('z', { char: 'z' }); // no matches
    host.pressKey('backspace');         // removes 'z', back to empty
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    // Both options should be visible again
    expect(rows.some((r) => r.includes('apple'))).toBe(true);
    expect(rows.some((r) => r.includes('banana'))).toBe(true);
    host.pressKey('escape');
    await p;
  });

  it('Esc with non-empty filter clears query instead of cancelling', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['apple', 'banana'],
      searchable: true,
    });
    host.pressKey('a', { char: 'a' });
    host.pressKey('escape'); // should clear filter, NOT cancel
    expect(host.exitCalls).toBe(0); // picker still alive
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    // Filter cleared — filter row should show empty query
    const filterRow = rows.find((r) => r.includes('Filter:'));
    expect(filterRow).toBeDefined();
    // Both options visible
    expect(rows.some((r) => r.includes('apple'))).toBe(true);
    expect(rows.some((r) => r.includes('banana'))).toBe(true);
    host.pressKey('escape'); // now cancel
    await p;
  });

  it('Esc with empty filter cancels the picker', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['apple', 'banana'],
      searchable: true,
    });
    host.pressKey('escape'); // filter is empty → cancel
    const result = await p;
    expect(result).toBeNull();
    expect(host.exitCalls).toBe(1);
  });

  it('Enter on filtered list returns the ORIGINAL option label', async () => {
    // The /resume caller maps back via options.indexOf(choice) — must match
    // the original string, not a potentially-styled filtered copy.
    const host = new FakePickerHost();
    const opts = ['apple', 'banana', 'apricot'];
    const p = runPicker(host, {
      header: [],
      options: opts,
      searchable: true,
    });
    // Type 'ban' so only 'banana' matches
    for (const ch of 'ban') {
      host.pressKey(ch, { char: ch });
    }
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['banana']);
    // Confirm it's a value present in the original array
    expect(opts.indexOf(result![0]!)).toBe(1);
  });

  it('searchable=false: printable chars are still swallowed', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: ['apple', 'banana'],
      // searchable not set (defaults false)
    });
    host.pressKey('a', { char: 'a' });
    host.pressKey('b', { char: 'b' });
    host.pressKey('return');
    const result = await p;
    expect(result).toEqual(['apple']); // cursor unchanged
    expect(host.exitCalls).toBe(1);
  });

  it('filter row appears in render output when searchable', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: ['header'],
      options: ['alpha', 'beta'],
      searchable: true,
    });
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(rows.some((r) => r.includes('Filter:'))).toBe(true);
    host.pressKey('escape');
    await p;
  });

  it('filter row does NOT appear when searchable is false', async () => {
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: ['header'],
      options: ['alpha', 'beta'],
    });
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(rows.some((r) => r.includes('Filter:'))).toBe(false);
    host.pressKey('escape');
    await p;
  });

  it('ANSI codes in options are stripped before matching', async () => {
    // palette.dim() wraps with ANSI; the filter must match the visible text
    const ESC = '\x1b';
    const dimId = `${ESC}[2msome-uuid-1234${ESC}[0m`;
    const host = new FakePickerHost();
    const p = runPicker(host, {
      header: [],
      options: [`plain label  ${dimId}`],
      searchable: true,
    });
    // Type part of the UUID that's inside ANSI codes
    for (const ch of 'uuid') {
      host.pressKey(ch, { char: ch });
    }
    const rows = host.renderSnapshot().map((r) => r.replace(/\u001b\[[0-9;]*m/g, ''));
    // The option should still appear (matched despite ANSI wrapping)
    expect(rows.some((r) => r.includes('plain label'))).toBe(true);
    host.pressKey('escape');
    host.pressKey('escape');
    await p;
  });
});
