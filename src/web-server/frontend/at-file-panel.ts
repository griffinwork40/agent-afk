/**
 * @file context injection affordance for the web composer.
 *
 * Adds an '@' button to the composer row. Clicking it opens a small popover
 * where the user can type a file path; pressing Enter (or 'Add') inserts the
 * @<path> token at the cursor position in the textarea. The server-side
 * turn-handler already expands @file tokens, so no client-side expansion is
 * needed — this is purely a UX shortcut for typing paths.
 *
 * Constraints:
 *  - No innerHTML (XSS prevention).
 *  - No inline styles (CSP: style-src 'self'). All styling via at-file.css.
 *  - DOM built exclusively with createElement / textContent / classList.
 */

export interface AtFileOpts {
  /** The composer textarea the token will be inserted into. */
  input: HTMLTextAreaElement;
  /** Parent element that receives the '@' button (appended as last child). */
  container: HTMLElement;
}

/**
 * Contract: path must be non-empty and start with /, ./, ~/, or contain no
 * leading slash (relative bare path like src/file.ts). Returns true when the
 * string passes this minimal gate so the UI can show an inline error.
 */
function looksLikePath(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  // Absolute, home-relative, explicit-relative, or bare relative.
  return s.startsWith('/') || s.startsWith('./') || s.startsWith('~/') || /^[\w.]/.test(s);
}

/** Insert `text` at the current cursor position of `ta`, then move the caret. */
function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  // Add a space before the token if we're not at the start of a line/value.
  const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  ta.value = before + prefix + text + ' ' + after;
  const pos = start + prefix.length + text.length + 1;
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

/**
 * Wire the @file affordance into `container`. Returns a cleanup function that
 * removes event listeners and DOM nodes added by this call (useful in tests).
 */
export function wireAtFileAffordance(opts: AtFileOpts): () => void {
  const { input, container } = opts;

  // ── trigger button ────────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'atf-btn';
  btn.title = 'Insert @file reference';
  btn.setAttribute('aria-label', 'Insert file reference');
  btn.textContent = '@';

  // ── popover ───────────────────────────────────────────────────────────────
  const popover = document.createElement('div');
  popover.className = 'atf-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Insert file path');
  popover.hidden = true;

  const hint = document.createElement('p');
  hint.className = 'atf-hint';
  hint.textContent = 'Type a file path. @~/file.ts or @src/file.ts';

  const inputRow = document.createElement('div');
  inputRow.className = 'atf-input-row';

  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'atf-path-input';
  pathInput.placeholder = 'src/foo.ts or ~/file.ts';
  pathInput.setAttribute('autocomplete', 'off');
  pathInput.setAttribute('spellcheck', 'false');

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'atf-add-btn';
  addBtn.textContent = 'Add';

  const errorMsg = document.createElement('p');
  errorMsg.className = 'atf-error';
  errorMsg.hidden = true;
  errorMsg.textContent = 'Enter a valid file path.';

  inputRow.appendChild(pathInput);
  inputRow.appendChild(addBtn);
  popover.appendChild(hint);
  popover.appendChild(inputRow);
  popover.appendChild(errorMsg);

  // ── open / close helpers ──────────────────────────────────────────────────
  function open(): void {
    popover.hidden = false;
    errorMsg.hidden = true;
    pathInput.value = '';
    btn.classList.add('atf-btn--active');
    btn.setAttribute('aria-expanded', 'true');
    pathInput.focus();
  }

  function close(): void {
    popover.hidden = true;
    btn.classList.remove('atf-btn--active');
    btn.setAttribute('aria-expanded', 'false');
  }

  function commit(): void {
    const raw = pathInput.value.trim();
    if (!looksLikePath(raw)) {
      errorMsg.hidden = false;
      pathInput.focus();
      return;
    }
    insertAtCursor(input, `@${raw}`);
    close();
  }

  // ── event wiring ──────────────────────────────────────────────────────────
  const onBtnClick = (): void => {
    popover.hidden ? open() : close();
  };

  const onAddClick = (): void => {
    commit();
  };

  const onPathKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { close(); }
  };

  // Dismiss on click outside.
  const onDocClick = (e: MouseEvent): void => {
    if (!popover.hidden && !container.contains(e.target as Node)) close();
  };

  btn.addEventListener('click', onBtnClick);
  addBtn.addEventListener('click', onAddClick);
  pathInput.addEventListener('keydown', onPathKeydown);
  document.addEventListener('click', onDocClick, { capture: true });

  // ── mount ────────────────────────────────────────────────────────────────
  container.appendChild(popover);
  container.appendChild(btn);

  // ── cleanup ───────────────────────────────────────────────────────────────
  return (): void => {
    btn.removeEventListener('click', onBtnClick);
    addBtn.removeEventListener('click', onAddClick);
    pathInput.removeEventListener('keydown', onPathKeydown);
    document.removeEventListener('click', onDocClick, { capture: true });
    popover.remove();
    btn.remove();
  };
}
