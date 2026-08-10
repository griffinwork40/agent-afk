/** Direct integration tests for the composer affordance mounting boundary. */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { wireComposerAffordances } from './composer-wiring.js';

function input(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.id = 'prompt';
  document.body.appendChild(el);
  return el;
}

describe('wireComposerAffordances', () => {
  it('gracefully skips wiring when the slash menu is absent', () => {
    document.body.innerHTML = '<div id="prompt-mirror"></div>';
    const loadCommands = vi.fn(() => Promise.resolve([]));
    expect(wireComposerAffordances({ input: input(), loadCommands })).toBeUndefined();
    expect(loadCommands).not.toHaveBeenCalled();
  });

  it('gracefully skips wiring when the mirror is absent', () => {
    document.body.innerHTML = '<div id="slash-menu" hidden></div>';
    const loadCommands = vi.fn(() => Promise.resolve([]));
    expect(wireComposerAffordances({ input: input(), loadCommands })).toBeUndefined();
    expect(loadCommands).not.toHaveBeenCalled();
  });

  it('mounts both the menu and mirror against one command load', async () => {
    document.body.innerHTML =
      '<div id="slash-menu" hidden></div><div id="prompt-mirror"></div>';
    const composer = input();
    const loadCommands = vi.fn(() =>
      Promise.resolve([{ name: '/mint', summary: 'ship a feature' }]),
    );
    const autocomplete = wireComposerAffordances({ input: composer, loadCommands });
    expect(autocomplete).toBeDefined();
    await autocomplete?.preload();

    composer.value = '/mint';
    composer.dispatchEvent(new Event('input'));
    await autocomplete?.refresh();

    expect(loadCommands).toHaveBeenCalledTimes(1);
    expect(document.getElementById('slash-menu')?.hidden).toBe(false);
    expect(document.getElementById('prompt-mirror')?.textContent).toContain('/mint');
  });
});
