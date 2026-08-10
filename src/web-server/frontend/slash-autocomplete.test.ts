/**
 * Invariant under test: the slash menu claims keys ONLY while it is open with
 * candidates, and never steals a plain Enter otherwise.
 *
 * The composer's submit handler (`QueuePanel.wire`) binds keydown on the same
 * textarea, and same-element listeners fire in attachment order. So the menu is
 * wired first and calls `stopImmediatePropagation()` on the keys it consumes.
 * That is load-bearing in both directions: too greedy and a multi-line prompt
 * loses its newline, too timid and Enter sends `/mi` instead of accepting
 * `/mint`. These cases pin both edges, including the exact collision case — a
 * later-attached submit listener that must NOT run when a candidate is taken.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { SlashAutocomplete, REPL_ONLY } from './slash-autocomplete.js';
import { mountSlashHighlight } from './slash-highlight.js';
import type { CommandEntry } from '../../cli/input/slash-match.js';

const COMMANDS: CommandEntry[] = [
  { name: '/mint', summary: 'ship a feature' },
  { name: '/model', summary: 'switch model' },
  { name: '/diagnose', summary: 'find root cause' },
];

/** Namespaced names, as the live registry serves them (`/bgsub:status`, …). */
const NAMESPACED: CommandEntry[] = [
  { name: '/bgsub:status', summary: 'background job status' },
  { name: '/bgsub:join', summary: 'join a background job' },
  { name: '/bgsub:cancel', summary: 'cancel a background job' },
  { name: '/mint', summary: 'ship a feature' },
];

interface Harness {
  ac: SlashAutocomplete;
  input: HTMLTextAreaElement;
  menu: HTMLElement;
  /** Keys the composer's (later-attached) submit handler actually saw. */
  submitSaw: string[];
  /**
   * Sends the later-attached handler actually performed. Unlike `submitSaw`
   * this mirrors QueuePanel.wire()'s REAL gate (`Enter` + meta/ctrl), which is
   * the only way a test can tell "menu declined to claim the chord" apart from
   * "menu claimed it and the send was lost".
   */
  submitted: string[];
  /** Visible composer text — the mirror, not the transparent textarea. */
  mirrorText: () => string;
  type: (value: string) => Promise<void>;
  press: (key: string) => void;
  pressWith: (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean }) => void;
  rows: () => string[];
}

function harness(commands: CommandEntry[] = COMMANDS): Harness {
  document.body.innerHTML =
    '<div id="slash-menu" hidden></div><div id="prompt-mirror"></div><textarea id="prompt"></textarea>';
  const menu = document.getElementById('slash-menu') as HTMLElement;
  const mirror = document.getElementById('prompt-mirror') as HTMLElement;
  const input = document.getElementById('prompt') as HTMLTextAreaElement;

  const ac = new SlashAutocomplete({
    input,
    menu,
    loadCommands: () => Promise.resolve(commands),
  });
  ac.wire();
  // Mounted exactly as composer-wiring.ts does, so the mirror is driven by the
  // same `input` events production relies on.
  mountSlashHighlight(input, mirror, (name) => ac.knows(name));

  // Stand-in for QueuePanel.wire()'s handler — attached AFTER, exactly as in
  // app.ts, so stopImmediatePropagation() is observable.
  const submitSaw: string[] = [];
  const submitted: string[] = [];
  input.addEventListener('keydown', (e) => {
    submitSaw.push(e.key);
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitted.push(input.value);
  });

  return {
    ac,
    input,
    menu,
    submitSaw,
    submitted,
    // paintMirror appends a zero-width space so a trailing newline still
    // occupies a line; strip it to compare against what the operator reads.
    mirrorText: () => (mirror.textContent ?? '').replace(/\u200b/g, ''),
    type: async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await ac.refresh();
    },
    press: (key: string) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    },
    pressWith: (key, mods) => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }),
      );
    },
    rows: () => Array.from(menu.querySelectorAll('.slash-name')).map((n) => n.textContent ?? ''),
  };
}

describe('accessible listbox contract', () => {
  it('starts closed with a discoverable combobox relationship', () => {
    const h = harness();
    expect(h.input.getAttribute('role')).toBe('combobox');
    expect(h.input.getAttribute('aria-haspopup')).toBe('listbox');
    expect(h.input.getAttribute('aria-expanded')).toBe('false');
    expect(h.input.getAttribute('aria-controls')).toBe(h.menu.id);
    expect(h.input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(h.menu.getAttribute('role')).toBe('listbox');
  });

  it('links the open textbox to exactly one selected option and follows movement', async () => {
    const h = harness();
    await h.type('/');
    const options = Array.from(h.menu.querySelectorAll('[role="option"]'));
    expect(h.input.getAttribute('aria-expanded')).toBe('true');
    expect(options).toHaveLength(3);
    expect(options.map((row) => row.id)).toEqual([
      'slash-menu-option-0',
      'slash-menu-option-1',
      'slash-menu-option-2',
    ]);
    expect(options.map((row) => row.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(h.input.getAttribute('aria-activedescendant')).toBe('slash-menu-option-0');

    h.press('ArrowDown');
    expect(h.input.getAttribute('aria-activedescendant')).toBe('slash-menu-option-1');
    expect(
      Array.from(h.menu.querySelectorAll('[role="option"]')).map((row) =>
        row.getAttribute('aria-selected'),
      ),
    ).toEqual(['false', 'true', 'false']);
  });

  it('cleans up expanded and active-descendant state on acceptance and close', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Enter');
    expect(h.input.getAttribute('aria-expanded')).toBe('false');
    expect(h.input.hasAttribute('aria-activedescendant')).toBe(false);

    await h.type('/mi');
    h.press('Escape');
    expect(h.input.getAttribute('aria-expanded')).toBe('false');
    expect(h.input.hasAttribute('aria-activedescendant')).toBe(false);
  });
});

describe('trigger', () => {
  it('opens on a bare slash token and lists matches', async () => {
    const h = harness();
    await h.type('/mi');
    expect(h.ac.isOpen()).toBe(true);
    expect(h.rows()).toEqual(['/mint']);
    expect(h.menu.hidden).toBe(false);
  });

  it('lists every command for a lone slash', async () => {
    const h = harness();
    await h.type('/');
    expect(h.rows()).toEqual(['/diagnose', '/mint', '/model']);
  });

  it('stays closed for ordinary prose', async () => {
    const h = harness();
    await h.type('hello there');
    expect(h.ac.isOpen()).toBe(false);
    expect(h.menu.hidden).toBe(true);
  });

  it('closes once a space is typed — the guard that protects Enter', async () => {
    const h = harness();
    await h.type('/mint');
    expect(h.ac.isOpen()).toBe(true);
    await h.type('/mint ');
    expect(h.ac.isOpen()).toBe(false);
  });

  it('closes when nothing matches', async () => {
    const h = harness();
    await h.type('/zzzz');
    expect(h.ac.isOpen()).toBe(false);
  });

  it('does not trigger on a slash mid-buffer', async () => {
    const h = harness();
    await h.type('see src/foo');
    expect(h.ac.isOpen()).toBe(false);
  });
});

describe('keyboard', () => {
  it('moves the selection with ArrowDown', async () => {
    const h = harness();
    await h.type('/');
    expect(h.ac.current()?.value).toBe('/diagnose');
    h.press('ArrowDown');
    expect(h.ac.current()?.value).toBe('/mint');
  });

  it('wraps around at both ends', async () => {
    const h = harness();
    await h.type('/');
    h.press('ArrowUp');
    expect(h.ac.current()?.value).toBe('/model');
    h.press('ArrowDown');
    expect(h.ac.current()?.value).toBe('/diagnose');
  });

  it('accepts the highlighted candidate on Enter, with a trailing space', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Enter');
    expect(h.input.value).toBe('/mint ');
    expect(h.ac.isOpen()).toBe(false);
  });

  it('accepts on Tab as well', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Tab');
    expect(h.input.value).toBe('/mint ');
  });

  it('closes on Escape without changing the buffer', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Escape');
    expect(h.ac.isOpen()).toBe(false);
    expect(h.input.value).toBe('/mi');
  });

  it('hides the menu element after accepting', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Enter');
    expect(h.menu.hidden).toBe(true);
    expect(h.menu.textContent).toBe('');
  });
});

describe('composer collision', () => {
  it('withholds Enter from the submit handler when a candidate is taken', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Enter');
    expect(h.submitSaw).not.toContain('Enter');
  });

  it('lets plain Enter reach the composer when the menu is closed', async () => {
    const h = harness();
    await h.type('some prose');
    h.press('Enter');
    expect(h.submitSaw).toContain('Enter');
  });

  it('lets Enter through after the menu closes on a space', async () => {
    const h = harness();
    await h.type('/mint');
    await h.type('/mint ');
    h.press('Enter');
    expect(h.submitSaw).toContain('Enter');
  });

  it('does not intercept unrelated keys while open', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('a');
    expect(h.submitSaw).toContain('a');
  });

  // Regression: the menu matched `e.key === 'Enter'` with no modifier check and
  // then called stopImmediatePropagation(), so the composer's submit chord was
  // consumed by the accept path and the send was silently dropped.
  it('lets Cmd+Enter reach the submit handler while the menu is open', async () => {
    const h = harness();
    await h.type('/mi');
    h.pressWith('Enter', { metaKey: true });
    expect(h.submitted).toEqual(['/mi']);
  });

  it('lets Ctrl+Enter reach the submit handler while the menu is open', async () => {
    const h = harness();
    await h.type('/mi');
    h.pressWith('Enter', { ctrlKey: true });
    expect(h.submitted).toEqual(['/mi']);
  });

  it('does not accept a candidate when the submit chord is pressed', async () => {
    const h = harness();
    await h.type('/mi');
    h.pressWith('Enter', { ctrlKey: true });
    expect(h.input.value).toBe('/mi');
  });

  it('still accepts on unmodified Enter', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Enter');
    expect(h.input.value).toBe('/mint ');
    expect(h.submitted).toEqual([]);
  });
});

describe('mirror sync on programmatic writes', () => {
  // Regression: accept() assigns `input.value` directly, which fires no `input`
  // event. The mirror is the ONLY visible copy of the text (the textarea is
  // painted transparent), so the accepted command stayed invisible until the
  // next keystroke.
  it('repaints the mirror when a candidate is accepted with Enter', async () => {
    const h = harness();
    await h.type('/mi');
    expect(h.mirrorText()).toBe('/mi');
    h.press('Enter');
    expect(h.input.value).toBe('/mint ');
    expect(h.mirrorText()).toBe('/mint ');
  });

  it('repaints the mirror when a candidate is accepted with Tab', async () => {
    const h = harness();
    await h.type('/mi');
    h.press('Tab');
    expect(h.mirrorText()).toBe('/mint ');
  });

  it('repaints the mirror when a candidate is accepted by mouse', async () => {
    const h = harness();
    await h.type('/mi');
    const row = h.menu.querySelector('.slash-row') as HTMLElement;
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(h.mirrorText()).toBe('/mint ');
  });
});

describe('namespaced commands', () => {
  // Regression: the trigger regex excluded ':', so typing the namespace
  // separator closed the menu exactly when the operator was narrowing within it.
  it('stays open after the namespace separator', async () => {
    const h = harness(NAMESPACED);
    await h.type('/bgsub:');
    expect(h.menu.hidden).toBe(false);
    expect(h.rows()).toEqual(['/bgsub:cancel', '/bgsub:join', '/bgsub:status']);
  });

  it('narrows within the namespace', async () => {
    const h = harness(NAMESPACED);
    await h.type('/bgsub:st');
    expect(h.rows()).toEqual(['/bgsub:status']);
  });

  it('still closes the moment a space is typed', async () => {
    const h = harness(NAMESPACED);
    await h.type('/bgsub:status ');
    expect(h.menu.hidden).toBe(true);
  });
});

describe('selection visibility', () => {
  // Regression: move() re-rendered but never scrolled, so arrowing past the
  // menu's 40vh fold left the selection off-screen and Enter accepted a
  // candidate the operator could not see.
  it('scrolls the newly selected row into view', async () => {
    const scrollIntoView = vi.fn();
    // jsdom does not implement scrollIntoView; the production call is
    // feature-detected, so the stub is what makes the behaviour observable.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    const h = harness();
    await h.type('/');
    h.press('ArrowDown');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('survives an environment without scrollIntoView', async () => {
    // Deleting the stub restores the bare-jsdom condition: arrowing must not
    // throw when the method is absent.
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    const h = harness();
    await h.type('/');
    expect(() => h.press('ArrowDown')).not.toThrow();
  });
});

describe('rendering', () => {
  it('badges REPL-only commands and leaves others unbadged', async () => {
    const h = harness();
    await h.type('/');
    const badged = Array.from(h.menu.querySelectorAll('.slash-row'))
      .filter((r) => r.querySelector('.slash-badge') !== null)
      .map((r) => r.querySelector('.slash-name')?.textContent);
    expect(badged).toEqual(['/model']);
    expect(REPL_ONLY.has('/model')).toBe(true);
    expect(REPL_ONLY.has('/mint')).toBe(false);
  });

  it('classifies and badges /sh directly as REPL-only', async () => {
    const h = harness([{ name: '/sh', summary: 'run a shell command' }]);
    await h.type('/sh');
    expect(REPL_ONLY.has('/sh')).toBe(true);
    expect(h.menu.querySelector('.slash-name')?.textContent).toBe('/sh');
    expect(h.menu.querySelector('.slash-badge')?.textContent).toBe('REPL only');
  });

  it('renders summaries as text, never as markup', async () => {
    const h = harness([{ name: '/x', summary: '<img src=x onerror=alert(1)>' }]);
    await h.type('/x');
    expect(h.menu.querySelector('img')).toBeNull();
    expect(h.menu.querySelector('.slash-summary')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('marks exactly one row selected', async () => {
    const h = harness();
    await h.type('/');
    expect(h.menu.querySelectorAll('.slash-row.is-selected')).toHaveLength(1);
  });
});

describe('command loading', () => {
  it('fetches the universe once across many keystrokes', async () => {
    const loadCommands = vi.fn(() => Promise.resolve(COMMANDS));
    document.body.innerHTML = '<div id="slash-menu" hidden></div><textarea id="prompt"></textarea>';
    const input = document.getElementById('prompt') as HTMLTextAreaElement;
    const ac = new SlashAutocomplete({
      input,
      menu: document.getElementById('slash-menu') as HTMLElement,
      loadCommands,
    });
    ac.wire();
    for (const v of ['/m', '/mi', '/min']) {
      input.value = v;
      await ac.refresh();
    }
    expect(loadCommands).toHaveBeenCalledTimes(1);
  });

  it('logs a diagnostic, degrades closed, and retries after loading fails', async () => {
    const h = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loadCommands = vi
      .fn<() => Promise<CommandEntry[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(COMMANDS);
    const ac = new SlashAutocomplete({
      input: h.input,
      menu: h.menu,
      loadCommands,
    });
    h.input.value = '/mi';
    await ac.refresh();
    expect(ac.isOpen()).toBe(false);
    expect(error).toHaveBeenCalledWith(
      '[web] failed to load slash-command autocomplete:',
      expect.objectContaining({ message: 'offline' }),
    );

    await ac.refresh();
    expect(loadCommands).toHaveBeenCalledTimes(2);
    expect(ac.isOpen()).toBe(true);
    error.mockRestore();
  });
});
