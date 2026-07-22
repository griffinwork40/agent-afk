/**
 * /editor — compose the current prompt in your external $EDITOR.
 *
 * Seeds a temp file with the input-box buffer, hands the terminal to $VISUAL /
 * $EDITOR, and on a clean exit loads the edited content back into the input box
 * (cursor at end) WITHOUT submitting — the user reviews and presses Enter.
 *
 * All the fragile work (editor resolution, TTY suspend/spawn/restore, buffer
 * read/write, temp cleanup) lives in the shared `openEditorForBuffer` helper so
 * the Ctrl+O key chord can reuse the same audited path.
 */

import { openEditorForBuffer } from './editor-open.js';
import type { SlashCommand } from '../types.js';

export const editorCmd: SlashCommand = {
  name: '/editor',
  aliases: ['/edit'],
  summary: 'Compose the current prompt in your external $EDITOR (Ctrl+O)',
  hint: 'When your prompt is long enough to want real editor keybindings — opens $VISUAL/$EDITOR seeded with the input box; on exit the text loads back for you to review and submit.',
  async handler(ctx) {
    await openEditorForBuffer({
      compositor: ctx.getCompositor?.() ?? null,
      notify: (kind, message) => {
        // Map the handoff's severity to the REPL writer. `info` for the polite
        // non-TTY refusal, `warn` for a nonzero/failed editor (buffer kept),
        // `error` for the missing-$EDITOR misconfiguration.
        if (kind === 'error') ctx.out.error(message);
        else if (kind === 'warn') ctx.out.warn(message);
        else ctx.out.info(message);
      },
    });
    return 'continue';
  },
};
