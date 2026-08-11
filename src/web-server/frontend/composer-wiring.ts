/**
 * Composer affordances: the slash menu and live slash highlighting.
 *
 * Extracted from `app.ts`, which sits near the repo's 350-line ceiling; this is
 * the same seam the queue/composer block was pulled through. Keeping the two
 * affordances together is deliberate — they share one command universe, and
 * the highlighter's notion of "known command" is the autocomplete's cache.
 */

import { SlashAutocomplete } from './slash-autocomplete.js';
import { mountSlashHighlight, repaintSlashHighlight } from './slash-highlight.js';
import type { CommandEntry } from '../../cli/input/slash-match.js';

export interface ComposerAffordanceDeps {
  input: HTMLTextAreaElement;
  /** Load the command universe; called at most once. */
  loadCommands: () => Promise<CommandEntry[]>;
}

/** Mount points this module discovers for itself, by id, from index.html. */
const MENU_ID = 'slash-menu';
const MIRROR_ID = 'prompt-mirror';

/**
 * Invariant: this must run BEFORE `QueuePanel.wire()`. Both bind keydown on
 * the same textarea, and same-element listeners fire in attachment order — the
 * menu has to see Enter first so it can accept a candidate and call
 * `stopImmediatePropagation()` instead of letting the composer send the
 * prompt. Call order is the whole mechanism; do not reorder the call site in
 * `app.ts`.
 *
 * Progressive enhancement: the mount points are looked up leniently here
 * rather than through `app.ts`'s throwing `$()`. A browser holding a cached
 * older index.html against a newer app.js would otherwise take the whole
 * composer down — trading a working chat surface for a missing dropdown.
 * Absent nodes mean no autocomplete and nothing worse, so this returns
 * `undefined` instead of throwing.
 */
export function wireComposerAffordances(
  deps: ComposerAffordanceDeps,
): SlashAutocomplete | undefined {
  const menu = document.getElementById(MENU_ID);
  const mirror = document.getElementById(MIRROR_ID);
  if (!menu || !mirror) return undefined;

  let autocomplete!: SlashAutocomplete;
  autocomplete = new SlashAutocomplete({
    input: deps.input,
    menu,
    loadCommands: deps.loadCommands,
    // Cache completion changes only slash-token classification. Repaint that
    // consumer directly; a synthetic input event would also refresh the menu.
    onCommandsLoaded: () =>
      repaintSlashHighlight(deps.input, mirror, (name) => autocomplete.knows(name)),
  });
  autocomplete.wire();

  // Highlighting reads the autocomplete's cache rather than fetching its own,
  // so the two can never disagree about what counts as a known command.
  mountSlashHighlight(deps.input, mirror, (name) => autocomplete.knows(name));
  deps.input.classList.add('slash-highlight-active');

  // Warm the cache so the first `/` highlights immediately instead of one
  // keystroke late. A failure here is already swallowed into an empty universe.
  void autocomplete.preload();

  return autocomplete;
}
