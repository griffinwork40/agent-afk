/**
 * Shared dependency surface + result constants for the REPL elicitation
 * handler.
 *
 * History: extracted verbatim from `elicitation-repl.ts` (#367). Holds the
 * `ReplElicitationDeps` injection interface and the shared terminal
 * `ElicitationResult` singletons used by every mode module.
 */

import type { ElicitationResult } from '../../agent/types/sdk-types.js';

export interface ReplElicitationDeps {
  /** Read a single line from the user. Returns the trimmed input string. */
  readLine: (prompt: string) => Promise<string>;
  /** Line writer — defaults to console.log elsewhere; tests inject captures. */
  writer: { line: (text?: string) => void };
  /** Returns the number of agent questions currently pending in the router queue. */
  pendingCount: () => number;
  /**
   * Called immediately before `readLine` is awaited. Should temporarily
   * release stdin raw-mode and the compositor keypress listener so the
   * readline interface can receive keystrokes without competition.
   * Optional — when absent the suspend/resume is a no-op (non-TTY, tests).
   */
  suspendInput?: () => void;
  /**
   * Called immediately after `readLine` resolves or rejects, before the
   * return value is processed. Should restore raw-mode and the compositor
   * keypress listener. Optional — when absent is a no-op.
   */
  resumeInput?: () => void;
  /**
   * Arrow-key picker for `choice` / `multi_choice` agent questions. Resolves
   * with the selected option(s) or `null` if the user cancels/aborts. When
   * absent (non-TTY surfaces, daemon, tests that don't exercise picker
   * UX), the handler falls back to a numbered-text prompt via `readLine`.
   *
   * The `header` array is rendered INSIDE the picker frame — meaning the
   * question prompt and option list disappear from the terminal as soon
   * as the user confirms or cancels. Only the single-line result echo
   * (committed via `writer.line` after the picker exits) survives in
   * scrollback. Mirrors inquirer.js conventions.
   */
  pickFromList?: (opts: {
    header: readonly string[];
    options: readonly string[];
    multi?: boolean;
    signal: AbortSignal;
  }) => Promise<readonly string[] | null>;
  /**
   * Text-input overlay for `text` / `number` agent questions. Same compositor
   * `enterPickerMode` mechanism as `pickFromList` — header + input row vanish
   * on confirm/cancel, leaving only the single-line echo in scrollback.
   *
   * `validate` is called on Enter; non-null return keeps the overlay open
   * with the error rendered below the input row. Resolves with the typed
   * string on confirm, `null` on Esc/Ctrl+C/abort.
   *
   * Optional — absent on non-TTY surfaces (daemon, pipes, tests that don't
   * exercise overlay UX). The handler falls back to the `readLine` numbered
   * path when this dep is undefined.
   */
  readTextOverlay?: (opts: {
    header: readonly string[];
    initial?: string;
    help?: string;
    validate?: (value: string) => string | null;
    signal: AbortSignal;
  }) => Promise<string | null>;
}

export const DECLINE: ElicitationResult = { action: 'decline' };
export const CANCEL: ElicitationResult = { action: 'cancel' };
export const ACCEPT: ElicitationResult = { action: 'accept' };
