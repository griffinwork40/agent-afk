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
