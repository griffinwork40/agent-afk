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
import { renderSlashRow } from './slash-autocomplete-render.js';

export { REPL_ONLY } from './slash-autocomplete-render.js';

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
  /** Notify a cache consumer without synthesizing a general input event. */
  onCommandsLoaded?: () => void;
}

export class SlashAutocomplete {
  private commands: CommandEntry[] | null = null;
  private loading: Promise<void> | null = null;
  private candidates: SlashCandidate[] = [];
  private selected = 0;
  private open = false;
  private openIntent = false;
  private focused = false;
  private composing = false;
  private generation = 0;
  private readonly menuId: string;
  private readonly status: HTMLElement;

  constructor(private readonly deps: SlashAutocompleteDeps) {
    // Keep the textarea's implicit multiline-textbox role. ARIA relationship
    // attributes expose the optional listbox without replacing honest native
    // semantics with role="combobox", which is invalid on a textarea.
    this.menuId = deps.menu.id || 'slash-autocomplete-listbox';
    this.focused = document.activeElement === deps.input;
    deps.menu.id = this.menuId;
    deps.menu.setAttribute('role', 'listbox');
    deps.input.removeAttribute('role');
    deps.input.setAttribute('aria-autocomplete', 'list');
    deps.input.setAttribute('aria-haspopup', 'listbox');
    deps.input.setAttribute('aria-controls', this.menuId);

    this.status = document.createElement('div');
    this.status.className = 'slash-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
    deps.menu.insertAdjacentElement('afterend', this.status);
    this.syncAria();
  }

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

  /** Warm the command cache without opening or refreshing the menu. */
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
    this.deps.input.addEventListener('focus', () => {
      this.focused = true;
    });
    this.deps.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.deps.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.deps.input.addEventListener('compositionend', () => {
      this.composing = false;
      if (this.openIntent) void this.refresh();
    });
    this.deps.input.addEventListener('input', () => {
      this.openIntent = true;
      if (!this.composing) void this.refresh();
    });
    // Invalidate an in-flight refresh so its eventual result cannot reopen.
    // Reset composing on blur: if the IME is abandoned without compositionend
    // (e.g. switching windows), plain typing must not stay permanently suppressed.
    this.deps.input.addEventListener('blur', () => {
      this.focused = false;
      this.composing = false;
      this.close(true);
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Composition keystrokes belong entirely to the IME. keyCode 229 covers
    // legacy engines that do not expose isComposing reliably.
    if (e.isComposing || e.keyCode === 229) return;

    // Escape also cancels a pending load, before there is an open menu whose
    // keyboard contract could otherwise observe the key.
    if (e.key === 'Escape' && (this.openIntent || this.loading !== null)) {
      this.close(true);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
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
    this.close(true);
    this.deps.input.focus();
    // Invariant: assigning `.value` fires no `input` event, and the highlight
    // mirror — the only visible copy of the text, since the textarea itself is
    // painted transparent — repaints solely on that event. Without this the
    // accepted command stays invisible until the next keystroke.
    notifyValueChanged(this.deps.input);
  }

  private close(cancelIntent = false): void {
    if (cancelIntent) {
      this.openIntent = false;
      this.generation += 1;
    }
    this.open = false;
    this.candidates = [];
    this.selected = 0;
    this.deps.menu.hidden = true;
    this.deps.menu.textContent = '';
    this.status.textContent = '';
    this.syncAria();
  }

  /** Synchronize the native textbox side of the listbox relationship. */
  private syncAria(): void {
    const open = this.isOpen();
    this.deps.input.setAttribute('aria-expanded', String(open));
    if (open) {
      this.deps.input.setAttribute('aria-activedescendant', this.optionId(this.selected));
      const current = this.candidates[this.selected];
      this.status.textContent = current
        ? `${this.candidates.length} suggestions. ${current.value}, ${this.selected + 1} of ${this.candidates.length}.`
        : '';
    } else {
      this.deps.input.removeAttribute('aria-activedescendant');
      this.status.textContent = '';
    }
  }

  /** Stable for a candidate's position in the current deterministic ranking. */
  private optionId(index: number): string {
    return `${this.menuId}-option-${index}`;
  }

  /** Recompute from the current buffer. Exposed for tests. */
  async refresh(): Promise<void> {
    // Direct callers (tests and initial integrations) may refresh before wire();
    // infer focus only when no blur/cancel intent has been recorded.
    if (!this.focused && document.activeElement === this.deps.input) this.focused = true;
    const value = this.deps.input.value;
    if (!SLASH_TRIGGER.test(value)) {
      this.close(true);
      return;
    }
    this.openIntent = true;
    const requestGeneration = ++this.generation;
    await this.ensureCommands();
    // Recheck all intent after the asynchronous boundary. Blur, Escape, a newer
    // refresh, or continued typing invalidates this generation.
    if (
      requestGeneration !== this.generation ||
      !this.openIntent ||
      !this.focused ||
      !SLASH_TRIGGER.test(this.deps.input.value)
    ) {
      if (requestGeneration === this.generation) this.close();
      return;
    }
    const query = this.deps.input.value.slice(1);
    // No recency argument: the browser has no REPL history to rank by, which
    // `matchSlashCandidates` documents as yielding alphabetical order.
    this.candidates = matchSlashCandidates(this.commands ?? [], query);
    this.selected = 0;
    this.open = this.candidates.length > 0;
    // A completed empty result is closed state, not latent open intent. This
    // keeps Escape and ARIA behavior honest until the next user input.
    this.openIntent = this.open;
    this.render();
  }

  private async ensureCommands(): Promise<void> {
    if (this.commands !== null) return;
    // Collapse concurrent keystrokes onto one in-flight request. A failure still
    // degrades gracefully, but remains retryable on the next slash keystroke.
    this.loading ??= this.deps
      .loadCommands()
      .then((cmds) => {
        this.commands = cmds;
        this.deps.onCommandsLoaded?.();
      })
      .catch((error: unknown) => {
        console.error('[web] failed to load slash-command autocomplete:', error);
      })
      .finally(() => {
        this.loading = null;
      });
    await this.loading;
  }

  private render(): void {
    const menu = this.deps.menu;
    menu.textContent = '';
    if (!this.isOpen()) {
      menu.hidden = true;
      this.syncAria();
      return;
    }
    this.candidates.forEach((cand, i) => {
      menu.appendChild(this.row(cand, i, i === this.selected));
    });
    menu.hidden = false;
    this.syncAria();
  }

  private row(cand: SlashCandidate, index: number, isSelected: boolean): HTMLElement {
    return renderSlashRow(cand, this.optionId(index), isSelected, (pick) => {
      this.selected = this.candidates.indexOf(pick);
      this.accept();
    });
  }
}
