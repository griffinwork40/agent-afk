/**
 * Chrome-layer helpers extracted from `app.ts` to keep that file under the
 * 350-line ceiling: toast notifications, mobile-sidebar close gestures, and
 * the inline session-creation form.
 *
 * No long-lived state lives here — all exports are side-effectful utilities
 * wired once at startup by the main module.
 */

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Show a transient toast notification in the #toast element.
 *
 * Contract: toast replaces the status-bar text for ephemeral errors (network
 * failures, API rejections) while the #status pill remains reserved for the
 * SSE transport state. Callers never need to hide the toast — the
 * `duration` timeout removes `is-visible` automatically, and the CSS
 * animation fades it out.
 */
export function showToast(msg: string, duration = 5000): void {
  const node = $('toast');
  if (!node) return;
  node.textContent = msg;
  node.hidden = false;
  node.classList.add('is-visible');
  setTimeout(() => {
    node.classList.remove('is-visible');
    setTimeout(() => { node.hidden = true; }, 300);
  }, duration);
}

/**
 * Wire the sidebar backdrop click and Escape key to close the mobile
 * navigation drawer.
 *
 * Contract: called once from `main()`. Safe to call before the backdrop
 * element exists (getElementById returns null and the listener is a no-op),
 * though in practice the DOM is already parsed when a `type="module"` script
 * runs.
 */
export function wireSidebarClose(): void {
  const backdrop = $('sidebar-backdrop');
  const sidebar = $('sidebar');

  backdrop?.addEventListener('click', () => {
    sidebar?.classList.remove('is-open');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      sidebar?.classList.remove('is-open');
    }
  });
}

/**
 * Toggle the inline session-creation form inside the sidebar.
 *
 * @param onCreate - callback receiving the chosen model and optional cwd;
 *   called when the user clicks "Create" or presses Enter.
 */
export function toggleNewSessionForm(
  onCreate: (model: string, cwd: string) => void,
): void {
  const existing = document.getElementById('new-session-form');
  if (existing) { existing.remove(); return; }

  const sidebar = $('sidebar');
  if (!sidebar) return;

  const form = document.createElement('div');
  form.id = 'new-session-form';
  form.className = 'new-session-form';

  const select = document.createElement('select');
  select.className = 'nsf-select';
  for (const m of ['haiku', 'sonnet', 'opus']) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === 'sonnet') opt.selected = true;
    select.appendChild(opt);
  }

  const cwdInput = document.createElement('input');
  cwdInput.type = 'text';
  cwdInput.className = 'nsf-input';
  cwdInput.placeholder = 'working directory (optional)';

  const createBtn = document.createElement('button');
  createBtn.className = 'nsf-btn';
  createBtn.textContent = 'Create';
  const commit = (): void => {
    form.remove();
    onCreate(select.value, cwdInput.value.trim());
  };
  createBtn.addEventListener('click', commit);
  cwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') form.remove();
  });

  form.append(select, cwdInput, createBtn);
  sidebar.insertAdjacentElement('afterbegin', form);
  cwdInput.focus();
}
