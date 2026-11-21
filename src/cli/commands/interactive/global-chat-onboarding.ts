/**
 * First-run screens for the global chat view: the notice and consent screen,
 * and the display-name screen with inline validation. Pure rendering; the
 * view owns keys and storage.
 *
 * @module cli/commands/interactive/global-chat-onboarding
 */

import { palette } from '../../palette.js';
import { suffixDisplayWidth, truncateDisplayWidth } from '../../display.js';
import { validateName } from '../../../global-chat/names.js';

// Kept to 20 lines so it fits one 80x24 screen with room to spare.
export const NOTICE_LINES: readonly string[] = [
  'Global chat: a public room for people who use AFK',
  '',
  'Before you join, here is what happens:',
  '- Messages are public. The relay stores each for 7 days with your public key',
  '  and display name, then deletes it.',
  '- It never stores or logs your raw IP address. While connected, it keeps a',
  '  salted address hash for limits. It keeps that hash longer only if banned.',
  '- Reports are stored with your public key until the reported message is deleted.',
  '- AFK does not put chat text in your agent context, transcript, or logs, and',
  '  gives the agent no chat tool. An agent with shell access is not sandboxed.',
  '',
  'Rules: be decent, no spam, no secrets (never paste keys or tokens).',
  'Turn it off any time with /global off.',
  '',
];
export const NOTICE_PROMPT = 'Join? Press y to agree and continue, n or Esc to go back.';
export const NOTICE_MIN_COLUMNS = 80;
export const NOTICE_MIN_ROWS = NOTICE_LINES.length + 1;

function pad(lines: string[], cols: number, rows: number): string[] {
  const out = lines.slice(0, Math.max(0, rows)).map((l) => truncateDisplayWidth(l, cols));
  while (out.length < rows) out.push('');
  return out;
}

export function renderNotice(cols: number, rows: number): string[] {
  if (cols < NOTICE_MIN_COLUMNS || rows < NOTICE_MIN_ROWS) {
    return pad([`Enlarge window to ${NOTICE_MIN_COLUMNS}x${NOTICE_MIN_ROWS} to read the notice. Esc leaves.`], cols, rows);
  }
  const lines = NOTICE_LINES.map((l, i) => (i === 0 ? palette.heading(l) : l));
  lines.push(palette.bold(NOTICE_PROMPT));
  return pad(lines, cols, rows);
}

export function nameFeedback(name: string): { ok: boolean; text: string } {
  if (name === '') return { ok: false, text: '2 to 16 characters: lowercase letters, digits, _ or -.' };
  const v = validateName(name);
  if (v.ok) return { ok: true, text: 'Looks good. Press Enter.' };
  return v.code === 'reserved_name'
    ? { ok: false, text: 'That name is reserved. Pick another.' }
    : { ok: false, text: 'Use 2 to 16 characters: lowercase letters, digits, _ or -.' };
}

export function renderNameScreen(input: string, error: string | null, busy: boolean, cols: number, rows: number): string[] {
  const fb = nameFeedback(input);
  const lines = [
    palette.heading('Pick a display name'),
    '',
    'Others will see it as name#tag. The tag comes from your key, so names need not be unique.',
    'You can change it later with /global name, at most once a day.',
    '',
    palette.dim('> ') + suffixDisplayWidth(input, Math.max(0, cols - 2)),
    busy ? palette.dim('Saving...') : error ? palette.error(error) : fb.ok ? palette.success(fb.text) : palette.dim(fb.text),
    '',
    palette.dim(busy ? 'Saving your identity. Please wait.' : 'Enter to save, Esc to go back without saving anything.'),
  ];
  return pad(lines, cols, rows);
}
