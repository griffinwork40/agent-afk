import * as path from 'node:path';

/**
 * Capture-mode detection.
 *
 * **Why this exists.** AFK's TUI uses `log-update` to repaint an overlay
 * region in place via cursor-up + erase-line ANSI escape sequences. In a
 * real interactive TTY these escapes overwrite the prior frame so the user
 * sees one stable region. But when stdout is being *recorded* — by
 * `script(1)`, `asciinema rec`, a screen-recording session that captures
 * raw bytes, or via `AFK_DEMO_CLEAN=1` opt-in — those escape codes survive
 * as bytes in the captured stream. The terminal that *played back* the
 * recording may collapse them visually, but the *captured artifact* (a
 * `typescript` file, a `.cast` file, a copy-paste from a recording-aware
 * terminal's scrollback) preserves every repaint frame.
 *
 * For a write_file that takes 4 seconds, the spinner ticker fires at 80ms
 * intervals (12.5 Hz) and each tick repaints the full composed frame —
 * including the 8-line tool-lane diff overlay. That's ~50 captured copies
 * of the same overlay window in the artifact for one tool call. Across a
 * session, the repetition counts reach the hundreds.
 *
 * Capture-mode short-circuits the high-frequency repaint drivers (spinner
 * ticker; live thinking-preview overlay) while leaving committed scrollback
 * writes and state-transition-driven repaints alone. The result: a captured
 * artifact that contains the genuine signal once per state change instead
 * of once per timer tick.
 *
 * **Trigger surface.** Detection is intentionally narrow:
 * - `AFK_DEMO_CLEAN=1` — explicit opt-in for users recording a demo.
 * - `SCRIPT` env present — `script(1)` on BSD/macOS/Linux sets this to the
 *   typescript filename for the duration of the recording.
 * - `ASCIINEMA_REC=1` — `asciinema rec` sets this while recording.
 *
 * CI environments are *not* listed: they typically run with `isTTY=false`,
 * which the rest of the renderer already handles via the non-TTY fallback.
 * Adding CI markers here would be redundant and would risk regressing
 * live-CI dashboards that consume the existing non-TTY output.
 */

/**
 * Decide whether capture-mode should be on for this session.
 *
 * Reads `process.env` at call time. Pure function with no side effects —
 * callers cache the result at construction time (the env doesn't change
 * mid-process for these specific variables in practice).
 */
export function detectCaptureMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['AFK_DEMO_CLEAN'] === '1') return true;
  if (typeof env['SCRIPT'] === 'string' && env['SCRIPT'].length > 0) return true;
  if (env['ASCIINEMA_REC'] === '1') return true;
  return false;
}

/**
 * Decide whether the completion bell should ring on turn completion and
 * elicitation requests.
 *
 * AFK_BELL=1 opts in to audible terminal bell (BEL, \x07) on turn completion
 * and when agent input is needed (for away-from-keyboard scenarios). Off by
 * default; TTY-only (ringBellIfEnabled checks isTTY).
 *
 * Reads `process.env` at call time. Pure function with no side effects.
 */
export function detectBell(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AFK_BELL'] === '1';
}

/**
 * Decide whether reduced-motion mode should suppress the spinner animation ticker.
 *
 * AFK_REDUCED_MOTION=1 opts in to suppressing the high-frequency spinner ticker
 * (which repaints at 12.5 Hz). This is a USER PREFERENCE for motion sensitivity,
 * distinct in intent from capture-mode (which suppresses replay artifacts). State-
 * transition-driven repaints (tool completion, new content blocks) are unaffected.
 *
 * Reads `process.env` at call time. Pure function with no side effects.
 */
export function detectReducedMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AFK_REDUCED_MOTION'] === '1';
}

/**
 * Decide whether the input caret should blink (pulse on/off like a terminal
 * cursor).
 *
 * ON by default; `AFK_CARET_BLINK=0` opts OUT (steady caret). Only the literal
 * string "0" disables — any other value (or unset) leaves blinking on. Distinct
 * in intent from reduced-motion: a motion-sensitive user sets
 * `AFK_REDUCED_MOTION=1`, which the interactive caller ANDs in to force the
 * caret solid regardless of this flag. Kept here beside detectReducedMotion /
 * detectBell because it is the same class of CLI motion / UX preference, read
 * via the same `env`-parameter pattern.
 *
 * Reads `process.env` at call time. Pure function with no side effects.
 */
export function detectCaretBlink(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AFK_CARET_BLINK'] !== '0';
}

/**
 * Decide whether the spinner uses the goblin theme (olive frames + goblin verb
 * pool) while the agent works.
 *
 * ON by default; `AFK_GOBLIN_SPINNER=0` opts OUT (the classic dim noir spinner).
 * Only the literal "0" disables — any other value (or unset) leaves it on.
 * Purely cosmetic: no timer or layout change, so it is independent of
 * reduced-motion / capture-mode. Kept here beside the other CLI UX-preference
 * detectors, read via the same `env`-parameter pattern.
 *
 * Reads `process.env` at call time. Pure function with no side effects.
 */
export function detectGoblinSpinner(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AFK_GOBLIN_SPINNER'] !== '0';
}

/**
 * Ring the terminal bell (audible BEL, \x07) if the bell is enabled
 * and the stream is a TTY. Non-printing; does not disturb the overlay.
 *
 * No-op when AFK_BELL !== '1' or when stream.isTTY is falsy.
 * Reads from process.env if env is not provided.
 */
export function ringBellIfEnabled(
  stream: { write(s: string): unknown; isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (detectBell(env) && stream.isTTY) {
    stream.write('\x07');
  }
}

/**
 * Decide whether the terminal/tab title should track afk state via OSC 2.
 *
 * ON by default; `AFK_TERM_TITLE=0` opts OUT (leave the title alone). Only the
 * literal string "0" disables — any other value (or unset) leaves it on. This
 * matches the opt-OUT convention of the other default-ON UX detectors here
 * (detectCaretBlink / detectGoblinSpinner) rather than the opt-IN bell.
 *
 * The escape itself is only emitted when the stream is also a TTY — see
 * `setTerminalTitleIfEnabled`. This detector answers only "is the feature
 * enabled", never "is it safe to write" (that is the caller's isTTY check).
 *
 * Reads `process.env` at call time. Pure function with no side effects.
 */
export function detectTermTitle(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AFK_TERM_TITLE'] !== '0';
}

/**
 * Decide whether a desktop completion notification should be emitted via OSC 9
 * when a turn completes.
 *
 * OFF by default; `AFK_NOTIFY=1` opts IN. Desktop notifications are intrusive
 * (they pop a system banner outside the terminal), so — like the audible bell
 * (detectBell) — this is strictly opt-in: only the literal "1" enables. Any
 * other value (or unset) leaves it off.
 *
 * Reads `process.env` at call time. Pure function with no side effects.
 */
export function detectNotify(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AFK_NOTIFY'] === '1';
}

/**
 * Compose the OSC 2 terminal-title string for a given working directory and
 * running state. Pure string builder — no I/O, no TTY/env gating.
 *
 *   running=true  → `afk — <basename(cwd)> · running`
 *   running=false → `afk — <basename(cwd)>`
 *
 * Uses an em dash (—) as the brand separator and a middle dot (·) before the
 * running badge, matching the status-line / footer typography used elsewhere
 * in the REPL. `basename` is computed with `path.basename`, so a trailing
 * slash or a root path collapses to a sensible label.
 */
export function formatTerminalTitle(cwd: string, running: boolean): string {
  const base = path.basename(cwd) || cwd;
  return running ? `afk — ${base} · running` : `afk — ${base}`;
}

// Contract: OSC 2/9 emitters below own the TTY + feature gate for the two
// terminal-integration escapes. Both mirror `ringBellIfEnabled`:
//   - they take the target `stream` (so tests inject a spy and production
//     passes `process.stdout`);
//   - they no-op unless the feature is enabled AND `stream.isTTY` is truthy,
//     so escape bytes never leak into pipes, files, or non-TTY CI logs;
//   - they read `env` via the same injectable-default pattern.
// OSC 2 (`ESC ] 2 ; <text> BEL`) and OSC 9 (`ESC ] 9 ; <text> BEL`) are both
// zero-width, cursor-neutral, non-scrolling control strings: they set window
// state without moving the cursor or emitting a newline. That is why they are
// safe to write raw to `process.stdout` at the SAME lifecycle points the bell
// is (turn start/end after the per-turn renderer is disposed, REPL start
// before the compositor arms, clean exit after it is disarmed) without
// corrupting the persistent compositor's log-update row accounting — the same
// invariant that lets `ringBellIfEnabled` write `\x07` raw.

/**
 * Set the terminal/tab title to `title` via OSC 2 (`ESC ] 2 ; <title> BEL`)
 * when the title feature is enabled and the stream is a TTY. No-op otherwise.
 *
 * Pass the empty string to CLEAR the title (terminals reset the tab label to
 * their default). Non-printing; does not disturb a live overlay frame.
 *
 * No-op when AFK_TERM_TITLE === '0' or when stream.isTTY is falsy.
 * Reads from process.env if env is not provided.
 */
export function setTerminalTitleIfEnabled(
  stream: { write(s: string): unknown; isTTY?: boolean },
  title: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (detectTermTitle(env) && stream.isTTY) {
    stream.write(`\x1b]2;${title}\x07`);
  }
}

/**
 * Emit a desktop completion notification via OSC 9 (`ESC ] 9 ; <message> BEL`)
 * when notifications are enabled and the stream is a TTY. No-op otherwise.
 * Terminals that map OSC 9 to the desktop notification service (iTerm2, kitty,
 * WezTerm) raise a system banner; terminals that do not simply ignore it.
 *
 * No-op when AFK_NOTIFY !== '1' or when stream.isTTY is falsy.
 * Reads from process.env if env is not provided.
 */
export function notifyIfEnabled(
  stream: { write(s: string): unknown; isTTY?: boolean },
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (detectNotify(env) && stream.isTTY) {
    stream.write(`\x1b]9;${message}\x07`);
  }
}
