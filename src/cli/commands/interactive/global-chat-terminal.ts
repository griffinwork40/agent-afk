/**
 * Terminal takeover and restore for the global chat view, built on injected
 * handles so it can be tested without a real TTY. Mirrors the lifecycle in
 * `task-view-mid-turn.ts`.
 *
 * @module cli/commands/interactive/global-chat-terminal
 */

import { registerCleanup as registerProcessCleanup } from '../../../utils/cleanupRegistry.js';

/** The subset of `TerminalCompositor` this view uses. */
export interface ChatCompositor {
  suspendInput(): void;
  resumeInput(): void;
  repaint(): void;
}
export interface ChatStdin {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (data: Buffer | string) => void): unknown;
  setRawMode?(mode: boolean): unknown;
}
export interface ChatStdout {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  on(event: 'resize', listener: () => void): unknown;
  removeListener(event: 'resize', listener: () => void): unknown;
}
export interface ChatTeardownGuards {
  /** Runs on the REPL's signal/close cleanup path. Returns an unregister function. */
  registerCleanup(fn: () => Promise<void>): () => void;
  /** Runs synchronously on process exit. Returns a remove function. */
  onProcessExit(fn: () => void): () => void;
}

export const defaultGuards: ChatTeardownGuards = {
  registerCleanup: registerProcessCleanup,
  onProcessExit: (fn) => {
    process.on('exit', fn);
    return () => { process.removeListener('exit', fn); };
  },
};

// DEC private mode 1049 (alternate screen). Teardown constant is declared
// before the setup constant (ordered-sequence rule).
//
// Invariant: LEAVE_ALT_SCREEN is written BEFORE compositor.resumeInput(), or
// the compositor repaints into the alternate buffer and the REPL screen is
// never restored.
export const LEAVE_ALT_SCREEN = '\x1b[?25h\x1b[?1049l';
export const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H';

export interface Takeover {
  /** Normal exit path. Idempotent. */
  restore(): void;
}

/**
 * Take the terminal. `onCrash` runs on the signal/exit paths (it must be
 * synchronous-safe: no awaits that the process exit could cut short).
 *
 * Invariant: one `fired` flag is shared by the cleanup-registry guard, the
 * process-exit guard, and `restore()`, so the terminal is restored exactly
 * once whichever path runs first. `restore()` disarms both guards first.
 *
 * Invariant (restore order): raw mode off, guards disarmed, leave the
 * alternate screen, run `afterLeave` (resume recording), then
 * `compositor.resumeInput()` and `compositor.repaint()`. Recording is paused
 * just before entering and resumed just after leaving, so a cast holds no chat
 * text and never an unmatched enter or leave sequence.
 */
export function takeTerminal(params: {
  compositor: ChatCompositor;
  stdin: ChatStdin;
  stdout: ChatStdout;
  guards: ChatTeardownGuards;
  /** Runs just before the alternate screen is entered (pause recording). */
  afterEnter: () => void;
  afterLeave: () => void;
  onCrash: () => void;
}): Takeover {
  const { compositor, stdin, stdout, guards, afterEnter, afterLeave, onCrash } = params;
  let fired = false;
  const leave = (): boolean => {
    if (fired) return false;
    fired = true;
    try { stdin.setRawMode?.(false); } catch { /* non-TTY */ }
    stdout.write(LEAVE_ALT_SCREEN);
    try { afterLeave(); } catch { /* recorder failure must not strand the terminal */ }
    return true;
  };
  const crash = (): void => {
    if (fired) return;
    try { onCrash(); } catch { /* best effort */ }
    leave();
  };
  // Guards are armed before any setup so a throw mid-setup still restores.
  const unregister = guards.registerCleanup(async () => { crash(); });
  const removeExit = guards.onProcessExit(crash);
  const restore = (): void => {
    unregister();
    removeExit();
    if (!leave()) return;
    compositor.resumeInput();
    compositor.repaint();
  };

  // suspendInput hands stdin and raw mode back to us; the compositor turns raw
  // mode off on suspend, so it is re-enabled for per-byte keystrokes.
  compositor.suspendInput();
  try { stdin.setRawMode?.(true); } catch { /* non-TTY */ }
  try { afterEnter(); } catch { /* recorder pause is best effort */ }
  stdout.write(ENTER_ALT_SCREEN);
  return { restore };
}

/** Paint full frames, one write per frame. Each row is positioned and cleared. */
export function paintFrame(stdout: ChatStdout, lines: readonly string[]): void {
  let out = '';
  lines.forEach((line, i) => { out += `\x1b[${i + 1};1H\x1b[2K${line}`; });
  stdout.write(out);
}
