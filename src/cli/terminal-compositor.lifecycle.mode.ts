/**
 * Mode-transition helpers — extracted from terminal-compositor.lifecycle.ts (#2108).
 *
 * Encapsulates the raw-mode and bracketed-paste DEC private mode sequences
 * that `arm()` enables on the way in and `disarm()` disables on the way out.
 * Extracted so the transition logic lives in one place — reducing the chance
 * that an arm-side enable is added without a matching disarm-side disable, the
 * primary driver of the "state-machine desync" risk class in the original file.
 *
 * All helpers are side-effect-only writes (no state reads beyond the streams).
 */

import type { LifecycleHost } from './terminal-compositor.lifecycle.js';

/**
 * Enable raw mode on stdin. Throws if `setRawMode` fails — callers must handle
 * the error and roll back any state mutated before this call.
 * The caller is responsible for capturing `stdin.isRaw` into `self.wasRaw`
 * BEFORE calling this function so the prior state can be restored in disarm().
 */
export function enterRawMode(self: LifecycleHost): void {
  self.stdin.setRawMode(true);
}

/**
 * Restore the terminal's prior raw-mode state. Best-effort: a throw (e.g.
 * stdin already closed) is swallowed so it does not abort disarm().
 */
export function exitRawMode(self: LifecycleHost): void {
  try {
    self.stdin.setRawMode(self.wasRaw);
  } catch {
    /* noop — stdin may be closed */
  }
}

/**
 * Enable bracketed-paste mode and the rxvt scroll-key mode on stdout.
 *
 * - `\x1b[?2004h` — bracketed-paste: wraps clipboard content in
 *   `\x1b[200~...\x1b[201~` so the Enter handler can distinguish pasted
 *   line breaks from user-submission Enter.
 * - `\x1b[?1011h` — rxvt scrollKey: snaps the viewport to the bottom of
 *   scrollback on any keypress. Default-on in most terminals; this covers
 *   configurations where it has been disabled.
 *
 * Best-effort: a throwing write (e.g. stdout closed mid-arm) is swallowed.
 */
export function enableBracketedPasteAndScrollKey(self: LifecycleHost): void {
  try {
    self.stdout.write('\x1b[?2004h\x1b[?1011h');
  } catch {
    /* stdout closed mid-arm — best-effort */
  }
}

/**
 * Disable bracketed-paste mode and the rxvt scroll-key mode on stdout.
 *
 * Must be called BEFORE `exitRawMode()` — on rapid disarm/process-exit the
 * disable sequences can be dropped if raw mode is restored first (kernel TTY
 * flush race). Mirrors the drain-ordering note in disarm().
 *
 * Best-effort: a throwing write (stdout may be closed) is swallowed.
 */
export function disableBracketedPasteAndScrollKey(self: LifecycleHost): void {
  try {
    self.stdout.write('\x1b[?2004l\x1b[?1011l');
  } catch {
    /* stdout closed — best-effort */
  }
}
