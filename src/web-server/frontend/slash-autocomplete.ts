/**
 * Slash-command autocomplete for the web composer.
 *
 * Ranking is NOT reimplemented here: it delegates to `cli/input/slash-match`,
 * the same pure module the terminal REPL's dropdown ranks with, so the two
 * surfaces order candidates identically by construction. That module is
 * deliberately free of node builtins so esbuild can bundle it for the browser;
 * `cli/input/trigger.ts` (the REPL's caller) imports `fs` and cannot be shared.
 *
 * ## What this does NOT claim
 *
 * Nothing in this surface executes slash commands — the composer's prompt path
 * POSTs text that reaches the model verbatim. This dropdown is therefore an
 * INSERT affordance: it helps the operator type an exact command name, and
 * makes no promise that any given command does something. The one claim it
 * does make is negative and verifiable: {@link REPL_ONLY} names commands that
 * drive terminal-only machinery (screen, compositor, TTY, process lifetime)
 * and so could not act here even in principle. Everything else is listed
 * plainly, with no badge and no implied guarantee.
 */

import { matchSlashCandidates, type CommandEntry, type SlashCandidate } from '../../cli/input/slash-match.js';
import { notifyValueChanged } from './composer-value.js';

/**
 * Commands that drive terminal-only machinery — the screen, the compositor,
 * the TTY, or the REPL process itself — and therefore cannot act on this
 * surface even once slash dispatch exists server-side. Badged in the dropdown.
 *
 * Invariant: this list makes a NEGATIVE claim only. Absence from it is not a
 * promise that a command works here; it means we have no verified basis to say
 * it cannot. Keep entries to ones whose REPL-only nature is evident from what
 * they manipulate, so the badge never becomes a guess.
 */
export const REPL_ONLY: ReadonlySet<string> = new Set([
  '/clear',
  '/compact',
  '/editor',
  '/exit',
  '/fast',
  '/font-size',
  '/fork',
  '/keys',
  '/model',
  '/reauth',
  '/resume',
  '/rewind',
  '/theme',
  '/thinking',
]);

/**
 * Trigger: the whole buffer is a bare slash token.
 *
 * Matching the ENTIRE value (not a prefix of it) is what keeps Enter-capture
 * safe — the menu closes the moment a space is typed, so a multi-line prompt
 * being composed after a command name can never have its Enter swallowed.
 * Mirrors the REPL's slash trigger in `cli/input/trigger.ts`.
 *
 * Invariant: the character class must stay in sync with `SLASH_TOKEN` in
 * `slash-highlight.ts` — the registry serves namespaced names (`/bgsub:status`),
 * so excluding `:` here closed the menu exactly when the operator was narrowing
 * within a namespace. The leading `[A-Za-z]` matches the registry, where every
 * name is a slash followed by a letter; the optional group keeps a bare `/`
 * triggering the full list. Whitespace stays excluded — that is what makes
 * Enter-capture safe.
 */
const SLASH_TRIGGER = /^\/(?:[A-Za-z][\w:-]*)?$/;

export interface SlashAutocompleteDeps {
  /** The composer textarea. */
  input: HTMLTextAreaElement;
  /** Mount point for the dropdown; created hidden, shown on trigger. */
  menu: HTMLElement;
  /** Load the command universe. Called at most once, lazily. */
  loadCommands: () => Promise<CommandEntry[]>;
}

export class SlashAutocomplete {
  private commands: CommandEntry[] | null = null;
  private loading: Promise<void> | null = null;
  private candidates: SlashCandidate[] = [];
  private selected = 0;
  private open = false;

  constructor(private readonly deps: SlashAutocompleteDeps) {}

  /** True when the menu is showing at least one candidate. */
  isOpen(): boolean {
    return this.open && this.candidates.length > 0;
  }

  /**
   * Whether `name` is a registered command, for the highlighter.
   *
   * Answers `false` until the universe has loaded, so highlighting settles a
   * beat after the first `/` is typed rather than mislabelling a real command
   * as unknown forever. Loading is triggered by the same keystroke.
   */
  knows(name: string): boolean {
    return this.commands?.some((c) => c.name === name) ?? false;
  }

  /** Warm the command cache without opening the menu. */
  async preload(): Promise<void> {
    await this.ensureCommands();
  }

  /** Current highlighted candidate, or undefined when closed. */
  current(): SlashCandidate | undefined {
    return this.isOpen() ? this.candidates[this.selected] : undefined;
  }

  /**
   * Invariant: this must be attached BEFORE QueuePanel.wire(). Listeners on the
   * same element fire in attachment order, and the menu has to claim Enter
   * before the composer's submit handler sees it; `stopImmediatePropagation()`
   * is what prevents the later-attached listener from also running. Reversing
   * the order silently sends the prompt instead of accepting the candidate.
   */
  wire(): void {
    this.deps.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.deps.input.addEventListener('input', () => {
      void this.refresh();
    });
    // A click elsewhere dismisses, matching every other menu on the page.
    this.deps.input.addEventListener('blur', () => this.close());
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.isOpen()) return;

    // Invariant: the composer's submit chord must reach QueuePanel. Its handler
    // is bound to this same textarea AFTER ours (`app.ts` wires affordances
    // first), so `stopImmediatePropagation()` below would otherwise consume the
    // send and silently drop it. Modified Enter is never ours to claim.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return;

    // Contract: only these keys are claimed, and only while the menu is open
    // with candidates. Every other key — including plain Enter with no menu —
    // reaches the textarea and the composer untouched.
    switch (e.key) {
      case 'ArrowDown':
        this.move(1);
        break;
      case 'ArrowUp':
        this.move(-1);
        break;
      case 'Tab':
      case 'Enter':
        this.accept();
        break;
      case 'Escape':
        this.close();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private move(delta: number): void {
    const n = this.candidates.length;
    this.selected = (this.selected + delta + n) % n;
    this.render();
    this.revealSelected();
  }

  /**
   * Keep the highlighted row inside the menu's scroll viewport.
   *
   * A bare `/` yields up to `MAX_SLASH_MATCHES` rows while the menu is capped
   * at `40vh`, so arrowing past the fold would otherwise move the selection
   * out of sight and Enter would accept a candidate the operator cannot see.
   * `scrollIntoView` is absent in jsdom, so the call is feature-detected rather
   * than assumed — a missing implementation must not break key handling.
   */
  private revealSelected(): void {
    const row = this.deps.menu.children[this.selected];
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  private accept(): void {
    const pick = this.current();
    if (!pick) return;
    // The trailing space both reads naturally and closes the menu: the trigger
    // only matches a bare token, so the next `input` event finds no match.
    this.deps.input.value = `${pick.value} `;
    this.close();
    this.deps.input.focus();
    // Invariant: assigning `.value` fires no `input` event, and the highlight
    // mirror — the only visible copy of the text, since the textarea itself is
    // painted transparent — repaints solely on that event. Without this the
    // accepted command stays invisible until the next keystroke.
    notifyValueChanged(this.deps.input);
  }

  private close(): void {
    this.open = false;
    this.candidates = [];
    this.selected = 0;
    this.deps.menu.hidden = true;
    this.deps.menu.textContent = '';
  }

  /** Recompute from the current buffer. Exposed for tests. */
  async refresh(): Promise<void> {
    const value = this.deps.input.value;
    if (!SLASH_TRIGGER.test(value)) {
      this.close();
      return;
    }
    await this.ensureCommands();
    // Recheck: the fetch is async and the operator kept typing meanwhile.
    if (!SLASH_TRIGGER.test(this.deps.input.value)) {
      this.close();
      return;
    }
    const query = this.deps.input.value.slice(1);
    // No recency argument: the browser has no REPL history to rank by, which
    // `matchSlashCandidates` documents as yielding alphabetical order.
    this.candidates = matchSlashCandidates(this.commands ?? [], query);
    this.selected = 0;
    this.open = this.candidates.length > 0;
    this.render();
  }

  private async ensureCommands(): Promise<void> {
    if (this.commands !== null) return;
    // Collapse concurrent keystrokes onto one in-flight request.
    this.loading ??= this.deps
      .loadCommands()
      .then((cmds) => {
        this.commands = cmds;
      })
      .catch(() => {
        // A failed load degrades to "no autocomplete", never a broken composer.
        this.commands = [];
      });
    await this.loading;
  }

  private render(): void {
    const menu = this.deps.menu;
    menu.textContent = '';
    if (!this.isOpen()) {
      menu.hidden = true;
      return;
    }
    this.candidates.forEach((cand, i) => {
      menu.appendChild(this.row(cand, i === this.selected));
    });
    menu.hidden = false;
  }

  /** Build one row. `createElement` + `textContent` only — never innerHTML. */
  private row(cand: SlashCandidate, isSelected: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = isSelected ? 'slash-row is-selected' : 'slash-row';

    const name = document.createElement('span');
    name.className = 'slash-name';
    name.textContent = cand.value;
    row.appendChild(name);

    if (REPL_ONLY.has(cand.value)) {
      const badge = document.createElement('span');
      badge.className = 'slash-badge';
      badge.textContent = 'REPL only';
      badge.title = 'Drives terminal-only machinery; cannot act in the browser.';
      row.appendChild(badge);
    }

    if (cand.summary !== undefined && cand.summary !== '') {
      const summary = document.createElement('span');
      summary.className = 'slash-summary';
      summary.textContent = cand.summary;
      row.appendChild(summary);
    }

    // Pointer users get the same affordance; `mousedown` beats the input's
    // `blur`, which would otherwise close the menu before the click landed.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.selected = this.candidates.indexOf(cand);
      this.accept();
    });
    return row;
  }
}
