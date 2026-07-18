/**
 * Shared $EDITOR handoff — the engine behind both the `/editor` slash command
 * and the Ctrl+O key chord.
 *
 * Suspends the REPL's live input surface, spawns the user's external editor on
 * a temp file seeded with the current input-box buffer, and — on a clean exit —
 * loads the edited content back into the buffer (cursor at end) WITHOUT
 * submitting. The user reviews the loaded text and presses Enter themselves.
 *
 * Extracted to its own module so the slash command and the key chord share one
 * audited copy of the fragile TTY suspend/spawn/restore dance; each caller only
 * supplies a `notify` sink and the live compositor.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { env } from '../../../config/env.js';
import { InputCore } from '../../input-core.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';

/** Severity of a one-line notice surfaced to the user during the handoff. */
export type EditorNotifyKind = 'info' | 'warn' | 'error';

/** Dependencies the handoff needs — injected so both callers and tests can vary them. */
export interface EditorHandoffDeps {
  /**
   * The REPL's persistent compositor — source of the input buffer and owner of
   * the raw-mode stdin claim we must suspend/resume around the spawn. `null` on
   * non-TTY surfaces (daemon, pipe, tests without a compositor); the handoff
   * refuses politely in that case.
   */
  compositor: TerminalCompositor | null;
  /** One-line notice sink. Slash command → `ctx.out`; chord → a `commitAbove` writer. */
  notify: (kind: EditorNotifyKind, message: string) => void;
}

/** Outcome of an editor handoff attempt — returned for tests and callers that branch on it. */
export type EditorHandoffResult =
  | 'no-tty'        // no compositor / not an interactive surface — refused
  | 'no-editor'     // neither $VISUAL nor $EDITOR set — hinted, no spawn
  | 'loaded'        // editor exited 0 → buffer replaced with edited content
  | 'kept'          // editor exited nonzero / errored → original buffer preserved
  | 'spawn-failed'; // spawn threw synchronously → original buffer preserved

/**
 * Resolve the external editor command from the environment.
 *
 * Contract (resolution order): VISUAL first, then EDITOR — the standard POSIX
 * precedence (VISUAL names a full-screen editor; EDITOR is the line-editor
 * fallback, but modern setups point both at the same full-screen program). We
 * treat an EMPTY string as unset: the `env` getters return `''` for
 * `VISUAL=""`, and an empty command would spawn nothing useful, so the trim +
 * truthiness guard collapses both `unset` and `empty` to "not configured".
 *
 * Deliberately NO hardcoded `vi` fallback: guessing an editor the user did not
 * choose is worse than a one-line hint telling them to set VISUAL/EDITOR.
 * Returns null when neither is configured. The command string is split on
 * whitespace so `EDITOR="code --wait"` resolves to cmd=`code`, args=`--wait`.
 */
export function resolveEditor(): { cmd: string; args: string[] } | null {
  const raw = env.VISUAL?.trim() || env.EDITOR?.trim() || '';
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  return { cmd: parts[0]!, args: parts.slice(1) };
}

/**
 * Open the resolved editor on the current input buffer, then load the result
 * back into the buffer on a clean exit.
 *
 * Invariant (TTY handoff ordering — mirrors /transcript's pager handoff): the
 * editor inherits stdin (`stdio: 'inherit'`), so it reads the SAME fd 0 the
 * REPL owns. Before spawning we MUST (1) `suspendInput()` — drop the
 * compositor's keypress listener, unset raw mode, clear the input overlay — AND
 * (2) pause Node's stdin so the parent stops draining fd 0. Otherwise the REPL
 * reader and the editor both read() the shared fd and split every keystroke.
 * The inverse runs on child exit: resume stdin, then `resumeInput()` to re-arm
 * raw mode + the listener + repaint.
 *
 * Invariant (restore is unconditional): raw mode + the input claim are restored
 * in a `finally` even if `spawn` throws or the editor exits nonzero — a
 * half-suspended REPL is unrecoverable, so restoration must never be skipped.
 * The temp directory is likewise always removed.
 *
 * Contract (buffer preservation): a clean exit (code 0) REPLACES the buffer
 * with the edited file content (single trailing newline stripped, cursor at
 * end). A nonzero exit, a spawn error, or a synchronous spawn throw PRESERVES
 * the original buffer untouched and prints a notice. Never auto-submits — the
 * loaded text lands in the input box for the user to review and Enter.
 */
export async function openEditorForBuffer(deps: EditorHandoffDeps): Promise<EditorHandoffResult> {
  const { compositor, notify } = deps;

  // Non-TTY (daemon, pipe, tests without a compositor): there is no input box to
  // seed or repaint and no terminal to hand to a full-screen editor. Refuse in
  // one line, exactly like /transcript degrades on a non-TTY surface.
  if (!compositor || !process.stdout.isTTY) {
    notify('info', 'The editor handoff needs an interactive terminal — not available on this surface.');
    return 'no-tty';
  }

  const editor = resolveEditor();
  if (!editor) {
    notify(
      'error',
      'No editor configured. Set $VISUAL or $EDITOR (e.g. `export EDITOR=vim`) to compose prompts externally.',
    );
    return 'no-editor';
  }

  // Snapshot the composing buffer as submission-shaped text (paste placeholders
  // expanded to their originals) so the editor shows what the user would send,
  // not `[Pasted text #N]` tokens. Safe here because the handoff runs BETWEEN
  // turns (idle mode) — never after submit clears the paste registry.
  const original = compositor.getBuffer().text;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-editor-'));
  const filePath = path.join(dir, 'prompt.md');
  await fs.writeFile(filePath, original, { mode: 0o600 });

  let restored = false;
  const restoreInput = (): void => {
    if (restored) return;
    restored = true;
    try { process.stdin.resume(); } catch { /* best-effort */ }
    compositor.resumeInput();
  };

  compositor.suspendInput();
  try { process.stdin.pause(); } catch { /* best-effort */ }

  try {
    const code = await new Promise<number | null>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(editor.cmd, [...editor.args, filePath], { stdio: 'inherit' });
      } catch {
        // Synchronous spawn failure (bad options / unusual platform error).
        // Resolve with a sentinel the caller below maps to spawn-failed. The
        // finally still restores the TTY and removes the temp dir.
        resolve(Number.NaN);
        return;
      }
      child.on('error', () => resolve(Number.NaN));
      child.on('exit', (exitCode) => resolve(exitCode));
    });

    if (Number.isNaN(code)) {
      notify('warn', `Could not launch editor \`${editor.cmd}\` — keeping your current prompt.`);
      return 'spawn-failed';
    }

    if (code !== 0) {
      notify('warn', `Editor exited with status ${code} — keeping your current prompt.`);
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
    restoreInput();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
