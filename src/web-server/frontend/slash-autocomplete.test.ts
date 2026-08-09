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
import type { CommandEntry } from '../../cli/input/slash-match.js';

const COMMANDS: CommandEntry[] = [
  { name: '/mint', summary: 'ship a feature' },
  { name: '/model', summary: 'switch model' },
  { name: '/diagnose', summary: 'find root cause' },
];

interface Harness {
  ac: SlashAutocomplete;
  input: HTMLTextAreaElement;
  menu: HTMLElement;
  /** Keys the composer's (later-attached) submit handler actually saw. */
  submitSaw: string[];
  type: (value: string) => Promise<void>;
  press: (key: string) => void;
  rows: () => string[];
}

function harness(commands: CommandEntry[] = COMMANDS): Harness {
  document.body.innerHTML = '<div id="slash-menu" hidden></div><textarea id="prompt"></textarea>';
  const menu = document.getElementById('slash-menu') as HTMLElement;
  const input = document.getElementById('prompt') as HTMLTextAreaElement;

  const ac = new SlashAutocomplete({
    input,
    menu,
    loadCommands: () => Promise.resolve(commands),
  });
  ac.wire();

  // Stand-in for QueuePanel.wire()'s handler — attached AFTER, exactly as in
  // app.ts, so stopImmediatePropagation() is observable.
  const submitSaw: string[] = [];
  input.addEventListener('keydown', (e) => submitSaw.push(e.key));

  return {
    ac,
    input,
    menu,
    submitSaw,
    type: async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await ac.refresh();
    },
    press: (key: string) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    },
    rows: () => Array.from(menu.querySelectorAll('.slash-name')).map((n) => n.textContent ?? ''),
  };
}

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

  it('degrades to a closed menu when loading fails', async () => {
    const h = harness();
    const ac = new SlashAutocomplete({
      input: h.input,
      menu: h.menu,
      loadCommands: () => Promise.reject(new Error('offline')),
    });
    h.input.value = '/mi';
    await ac.refresh();
    expect(ac.isOpen()).toBe(false);
  });
});
