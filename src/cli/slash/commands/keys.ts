/**
 * /keys — printable keybinding reference for the interactive REPL.
 *
 * Grouped by category, using the same `palette` + `divider` conventions as
 * `core.ts`. No arguments accepted.
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import type { SlashCommand } from '../types.js';

const BINDINGS: Array<{ group: string; rows: Array<[string, string]> }> = [
  {
    group: 'Navigation',
    rows: [
      ['ctrl+a', 'Move to start of current line'],
      ['ctrl+e', 'Move to end of current line'],
      ['ctrl+b', 'Move one character backward (input mode) / Run turn in background (streaming mode)'],
      ['ctrl+f', 'Move one character forward'],
      ['alt+b', 'Move one word backward'],
      ['alt+f', 'Move one word forward'],
      ['← / →', 'Character left / right'],
      ['home / end', 'Buffer start / end'],
    ],
  },
  {
    group: 'Editing',
    rows: [
      ['ctrl+u', 'Delete to start of current line'],
      ['ctrl+k', 'Delete to end of current line'],
      ['ctrl+w', 'Delete previous word'],
      ['backspace', 'Delete previous character'],
      ['delete', 'Delete next character'],
      ['alt+backspace', 'Delete previous word (Option+Delete on macOS)'],
      ['alt+delete', 'Delete next word (Option+Fn-Delete on macOS)'],
    ],
  },
  {
    group: 'History',
    rows: [
      ['ctrl+p / ↑', 'Previous history entry (or move up in multi-line draft)'],
      ['ctrl+n / ↓', 'Next history entry (or move down in multi-line draft)'],
    ],
  },
  {
    group: 'Multi-line',
    rows: [
      ['shift+enter', 'Insert newline (no submit)'],
      ['alt+enter', 'Insert newline (no submit)'],
      ['<text>\\', 'Trailing \\ + Enter inserts newline (backwards-compat)'],
    ],
  },
  {
    group: 'Misc',
    rows: [
      ['ctrl+l', 'Clear screen and repaint'],
      ['ctrl+v', 'Paste image from clipboard'],
      ['ctrl+x', 'Remove last attached image'],
      ['ctrl+c', 'Interrupt running turn / exit (second press)'],
      ['ctrl+d', 'EOF / exit (when buffer is empty)'],
      ['tab', 'Accept autocomplete suggestion'],
      ['enter', 'Submit prompt'],
    ],
  },
];

export const keysCmd: SlashCommand = {
  name: '/keys',
  summary: 'Show keybinding reference',
  async handler(ctx) {
    ctx.out.line();
    ctx.out.line(palette.bold(palette.brand('Keybindings')));
    ctx.out.line(divider());

    // Compute column width for alignment.
    const allBindings = BINDINGS.flatMap((g) => g.rows);
    const maxKey = allBindings.reduce((m, [k]) => Math.max(m, k.length), 0);

    for (const { group, rows } of BINDINGS) {
      ctx.out.line();
      ctx.out.line(palette.bold(group));
      for (const [key, desc] of rows) {
        const padding = ' '.repeat(Math.max(0, maxKey - key.length));
        ctx.out.line(`  ${palette.warning(key)}${padding}  ${palette.dim(desc)}`);
      }
    }

    ctx.out.line();
    return 'continue';
  },
};
