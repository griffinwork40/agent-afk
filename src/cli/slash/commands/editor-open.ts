/**
 * Buffer-flavoured $EDITOR handoff — the engine behind both the `/editor` slash
 * command and the Ctrl+O key chord.
 *
 * Seeds a temp file with the current input-box buffer, hands the terminal to the
 * user's editor via the shared primitive in `editor-spawn.ts`, and — on a clean
 * exit — loads the edited content back into the buffer (cursor at end) WITHOUT
 * submitting. The user reviews the loaded text and presses Enter themselves.
 *
 * The fragile TTY suspend/spawn/restore dance itself lives in
 * `editor-spawn.ts`, so this module and `/afk-md` (which edits a real
 * persistent file) share one audited copy. This module owns only the temp-file
 * + input-buffer semantics layered on top.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InputCore } from '../../input-core.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import {
  spawnEditorOnPath,
  resolveEditor,
  type EditorNotifyKind,
} from './editor-spawn.js';

// Re-exported so existing importers of this module keep working unchanged.
export { resolveEditor };
export type { EditorNotifyKind };

/** Dependencies the handoff needs — injected so both callers and tests can vary them. */
export interface EditorHandoffDeps {
  /**
   * The REPL's persistent compositor — source of the input buffer and owner of
   * the raw-mode stdin claim the primitive suspends/resumes around the spawn.
   * `null` on non-TTY surfaces (daemon, pipe, tests without a compositor); the
   * handoff refuses politely in that case.
   */
  compositor: TerminalCompositor | null;
  /** One-line notice sink. Slash command → `ctx.out`; chord → a `commitAbove` writer. */
  notify: (kind: EditorNotifyKind, message: string) => void;
  /** Pause periodic footer writers while the editor owns the terminal. */
  suspendFooter?: () => void;
  /** Resume periodic footer writers after the editor exits. */
  resumeFooter?: () => void;
}

/** Outcome of an editor handoff attempt — returned for tests and callers that branch on it. */
export type EditorHandoffResult =
  | 'no-tty'        // no compositor / not an interactive surface — refused
  | 'no-editor'     // neither $VISUAL nor $EDITOR set — hinted, no spawn
  | 'loaded'        // editor exited 0 → buffer replaced with edited content
  | 'kept'          // editor exited nonzero / errored → original buffer preserved
  | 'spawn-failed'; // spawn threw synchronously → original buffer preserved

/**
 * Open the resolved editor on the current input buffer, then load the result
 * back into the buffer on a clean exit.
 *
 * Contract (buffer preservation): a clean exit (code 0) REPLACES the buffer
 * with the edited file content (single trailing newline stripped, cursor at
 * end). A nonzero exit, a spawn error, or a synchronous spawn throw PRESERVES
 * the original buffer untouched and prints a notice. Never auto-submits — the
 * loaded text lands in the input box for the user to review and Enter.
 *
 * Contract (temp-dir lifetime): the temp directory is always removed in a
 * `finally`, including on the refusal paths that never spawn.
 */
export async function openEditorForBuffer(deps: EditorHandoffDeps): Promise<EditorHandoffResult> {
  const { compositor, notify } = deps;

  // Contract (refusal before side effects): both refusal paths must return
  // WITHOUT creating a temp dir, so the two preconditions are probed here before
  // any filesystem work. The probe delegates to the primitive rather than
  // duplicating the checks, because the primitive owns the single audited copy
  // of each user-facing notice. `filePath` is inert on these paths — both checks
  // short-circuit ahead of the spawn — so an empty string is never opened.
  if (!compositor || !process.stdout.isTTY || !resolveEditor()) {
    const { outcome } = await spawnEditorOnPath({ compositor, filePath: '', notify });
    return outcome === 'no-editor' ? 'no-editor' : 'no-tty';
  }

  // Snapshot the composing buffer as submission-shaped text (paste placeholders
  // expanded to their originals) so the editor shows what the user would send,
  // not `[Pasted text #N]` tokens. Safe here because the handoff runs BETWEEN
  // turns (idle mode) — never after submit clears the paste registry.
  const original = compositor.getBuffer().text;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-editor-'));
  const filePath = path.join(dir, 'prompt.md');
  await fs.writeFile(filePath, original, { mode: 0o600 });

  try {
    const { outcome, exitCode } = await spawnEditorOnPath({
      compositor, filePath, notify,
      suspendFooter: deps.suspendFooter, resumeFooter: deps.resumeFooter,
    });

    if (outcome === 'spawn-failed') {
      const editor = resolveEditor();
      notify('warn', `Could not launch editor \`${editor?.cmd ?? 'editor'}\` — keeping your current prompt.`);
      return 'spawn-failed';
    }
    if (outcome !== 'clean') {
      // Only `nonzero` remains reachable here — the guard above consumed
      // no-tty/no-editor and `spawn-failed` returned already.
      notify('warn', `Editor exited with status ${exitCode} — keeping your current prompt.`);
      return 'kept';
    }

    const edited = await fs.readFile(filePath, 'utf8');
    // Strip exactly ONE trailing newline: editors almost always append a final
    // `\n` on save (POSIX text-file convention), which would otherwise land as a
    // stray blank line in the input box. A single strip is correct — the user
    // may legitimately want internal blank lines, and a lone deliberate trailing
    // newline is indistinguishable from the editor's, so we normalize to none.
    const normalized = edited.endsWith('\n') ? edited.slice(0, -1) : edited;
    // applyEdit(seed(text)) sets buffer + cursor-at-end + repaints in one call
    // (InputCore.seed places the cursor at text.length). NOT auto-submitted —
    // the text sits in the input box awaiting the user's Enter.
    compositor.applyEdit(InputCore.seed(normalized));
    return 'loaded';
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
