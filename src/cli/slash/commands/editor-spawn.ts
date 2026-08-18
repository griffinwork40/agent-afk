/**
 * The $EDITOR TTY handoff primitive — one audited copy of the fragile
 * suspend/spawn/restore dance, shared by every caller that hands the terminal
 * to an external editor.
 *
 * Extracted from `editor-open.ts` so a second caller (`/afk-md`, editing a real
 * persistent AFK.md) can reuse the dance instead of cloning it. This module
 * owns ONLY the terminal handoff: it does not create, read, write, or delete
 * files, and it never touches the input buffer. Those belong to the caller —
 * `openEditorForBuffer()` layers temp-file + buffer semantics on top,
 * `/afk-md` layers real-file + diff semantics on top.
 *
 * @module cli/slash/commands/editor-spawn
 */

import { spawn } from 'node:child_process';
import { env } from '../../../config/env.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';

/** Severity of a one-line notice surfaced to the user during the handoff. */
export type EditorNotifyKind = 'info' | 'warn' | 'error';

/**
 * Outcome of a handoff attempt.
 *
 * `clean` means the editor exited 0 — the conventional "saved and quit" signal.
 * `nonzero` means it exited with a failure status, which for most editors is how
 * "quit without saving" surfaces (`:cq` in vim); callers should treat it as
 * "abandon my changes" and leave prior state untouched.
 */
export type EditorSpawnOutcome = 'no-tty' | 'no-editor' | 'clean' | 'nonzero' | 'spawn-failed';

export interface EditorSpawnResult {
  outcome: EditorSpawnOutcome;
  /** The child's exit code when one was observed; null otherwise. */
  exitCode: number | null;
}

export interface EditorSpawnDeps {
  /**
   * The REPL's persistent compositor — owner of the raw-mode stdin claim we
   * must suspend/resume around the spawn. `null` on non-TTY surfaces (daemon,
   * pipe, tests without a compositor); the handoff refuses politely.
   */
  compositor: TerminalCompositor | null;
  /** Absolute path the editor opens. The caller guarantees it exists. */
  filePath: string;
  /** One-line notice sink. Slash command → `ctx.out`; chord → a `commitAbove` writer. */
  notify: (kind: EditorNotifyKind, message: string) => void;
  /** Pause periodic footer writers (health rail, bg bar, etc.) while the
   *  editor owns the terminal. Optional — absent on non-REPL surfaces. */
  suspendFooter?: () => void;
  /** Resume periodic footer writers after the editor exits. */
  resumeFooter?: () => void;
}

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
 * Hand the terminal to the user's editor, opened on `filePath`.
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
 *
 * Contract (write visibility): this resolves only after the child process has
 * exited, so on a `clean` outcome the editor's writes are already flushed to
 * disk and the caller may read the file back immediately.
 */
export async function spawnEditorOnPath(deps: EditorSpawnDeps): Promise<EditorSpawnResult> {
  const { compositor, filePath, notify } = deps;

  // Non-TTY (daemon, pipe, tests without a compositor): there is no terminal to
  // hand to a full-screen editor. Refuse in one line, exactly like /transcript
  // degrades on a non-TTY surface.
  if (!compositor || !process.stdout.isTTY) {
    notify('info', 'The editor handoff needs an interactive terminal — not available on this surface.');
    return { outcome: 'no-tty', exitCode: null };
  }

  const editor = resolveEditor();
  if (!editor) {
    notify(
      'error',
      'No editor configured. Set $VISUAL or $EDITOR (e.g. `export EDITOR=vim`) to compose prompts externally.',
    );
    return { outcome: 'no-editor', exitCode: null };
  }

  // Teardown is declared before setup so the inverse can never be orphaned.
  let restored = false;
  const restoreInput = (): void => {
    if (restored) return;
    restored = true;
    try { process.stdin.resume(); } catch { /* best-effort */ }
    compositor.resumeInput();
    deps.resumeFooter?.();
  };

  compositor.suspendInput();
  deps.suspendFooter?.();
  try { process.stdin.pause(); } catch { /* best-effort */ }

  try {
    const code = await new Promise<number | null>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(editor.cmd, [...editor.args, filePath], { stdio: 'inherit' });
      } catch {
        // Synchronous spawn failure (bad options / unusual platform error).
        // Resolve with a sentinel the caller below maps to spawn-failed. The
        // finally still restores the TTY.
        resolve(Number.NaN);
        return;
      }
      child.on('error', () => resolve(Number.NaN));
      child.on('exit', (exitCode) => resolve(exitCode));
    });

    if (Number.isNaN(code)) return { outcome: 'spawn-failed', exitCode: null };
    if (code !== 0) return { outcome: 'nonzero', exitCode: code };
    return { outcome: 'clean', exitCode: code };
  } finally {
    restoreInput();
  }
}
