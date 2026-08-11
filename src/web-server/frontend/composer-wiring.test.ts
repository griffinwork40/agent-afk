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

    // A real browser can only produce typing input while the textarea is the
    // active element; jsdom's synthetic event does not focus it implicitly.
    composer.focus();
    composer.value = '/mint';
    composer.dispatchEvent(new Event('input'));
    await autocomplete?.refresh();

    expect(loadCommands).toHaveBeenCalledTimes(1);
    expect(document.getElementById('slash-menu')?.hidden).toBe(false);
    expect(document.getElementById('prompt-mirror')?.textContent).toContain('/mint');
  });

  it('repaints a pre-existing command after preload without dispatching input', async () => {
    document.body.innerHTML =
      '<div id="slash-menu" hidden></div><div id="prompt-mirror"></div>';
    const composer = input();
    composer.value = '/mint';
    let release!: (commands: { name: string; summary: string }[]) => void;
    const loadCommands = vi.fn(
      () =>
        new Promise<{ name: string; summary: string }[]>((resolve) => {
          release = resolve;
        }),
    );

    const inputEvents = vi.fn();
    composer.addEventListener('input', inputEvents);
    const autocomplete = wireComposerAffordances({ input: composer, loadCommands });
    const mirror = document.getElementById('prompt-mirror') as HTMLElement;
    expect(mirror.querySelector('.tok-slash')?.textContent).toBe('/mint');
    expect(mirror.querySelector('.tok-known')).toBeNull();

    release([{ name: '/mint', summary: 'ship a feature' }]);
    await autocomplete?.preload();
    await autocomplete?.preload();

    expect(loadCommands).toHaveBeenCalledTimes(1);
    expect(inputEvents).not.toHaveBeenCalled();
    expect(mirror.querySelector('.tok-known')?.textContent).toBe('/mint');
    expect(mirror.querySelector('.tok-slash')).toBeNull();
  });
});
