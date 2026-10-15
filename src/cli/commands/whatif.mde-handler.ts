/**
 * Shared MDE-error handling logic for the `afk whatif` CLI command and the
 * `/whatif` slash handler (issue #2610).
 *
 * Both entry points face the same decision tree when `runWhatif` throws a
 * `WhatifMdeError`:
 *
 *  1. `--yes` is set → never prompt regardless of `--force`; exit/return with
 *     an error message.
 *  2. The refusal is MEASURED (baseline-sample gate) → cannot be cleared by
 *     `--force`; print `--no-baseline-sample` advice and exit/return.
 *  3. Otherwise (MDE gate or analyst-estimate headroom gate) → if in a TTY /
 *     interactive context, ask "Proceed anyway?".  If the user accepts, the
 *     caller re-runs with `force: true`.
 *
 * The helper is intentionally side-effect-free except through the provided
 * `write` callback so it can be used in both CLI (process.stderr.write) and
 * slash (ctx.out.error / ctx.out.warn) contexts.
 *
 * @module cli/commands/whatif.mde-handler
 */

import type { WhatifMdeError as WhatifMdeErrorType } from '../../whatif/run.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MdeAction =
  /** Caller must refuse — print the already-formatted message and exit/return. */
  | { kind: 'refuse'; message: string }
  /** Caller should ask the user "Proceed anyway?" and re-run with force: true if they accept. */
  | { kind: 'prompt'; detail: string };

// ---------------------------------------------------------------------------
// Core decision function
// ---------------------------------------------------------------------------

/**
 * Decide how to handle a `WhatifMdeError` thrown by `runWhatif`.
 *
 * Returns an `MdeAction` describing what the caller should do next.
 *
 * @param err     The thrown error (assumed to pass `isMdeError`).
 * @param yes     Whether `--yes` was passed (never prompt).
 * @param isInteractive  Whether the session has an interactive TTY/channel
 *                       available for the "Proceed anyway?" prompt.
 */
export function decideMdeAction(
  err: WhatifMdeErrorType,
  yes: boolean,
  isInteractive: boolean,
): MdeAction {
  const rawDetail = err.message.replace('whatif: run is underpowered — ', '');

  // Rule 2: measured refusals cannot be cleared by --force; advise --no-baseline-sample.
  // This check runs BEFORE the --yes guard so that the --no-baseline-sample advice is
  // included in the refuse message even when --yes is set.
  if (err.measured) {
    const advice =
      ' Pass --no-baseline-sample to skip the measured baseline gate and run anyway.';
    const message = rawDetail.includes('--no-baseline-sample')
      ? rawDetail
      : rawDetail + advice;
    return { kind: 'refuse', message };
  }

  // Rule 1: --yes always suppresses interactive prompts for non-measured errors.
  if (yes) {
    return {
      kind: 'refuse',
      message: `whatif: underpowered run refused — ${rawDetail}`,
    };
  }

  // Rule 3: clearable refusal in an interactive session → prompt.
  if (isInteractive) {
    return { kind: 'prompt', detail: rawDetail };
  }

  // Non-interactive, not --yes, not measured → print message and fail.
  return { kind: 'refuse', message: rawDetail };
}
