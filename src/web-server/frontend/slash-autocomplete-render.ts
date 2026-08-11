import type { SlashCandidate } from '../../cli/input/slash-match.js';

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
  '/sh',
  '/theme',
  '/thinking',
]);

/** Build one row. `createElement` + `textContent` only — never innerHTML. */
export function renderSlashRow(
  cand: SlashCandidate,
  optionId: string,
  isSelected: boolean,
  onAccept: (cand: SlashCandidate) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.id = optionId;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(isSelected));
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
    if (e.button !== 0) return;
    e.preventDefault();
    onAccept(cand);
  });
  return row;
}
