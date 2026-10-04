/**
 * Model-facing result for a bash command that was KILLED mid-run, by either
 * the turn's abort signal (user ESC / Ctrl+C soft-stop, subagent cancel,
 * compose fail-fast) or the per-call `timeout_ms`.
 *
 * Contract: both paths SIGKILL the process group and settle immediately, so
 * whatever stdout/stderr was accumulated up to that moment is the only record
 * of how far the command got. Before this helper both paths discarded it and
 * returned a bare sentinel (`Command aborted` / `Command timed out after Nms`),
 * leaving the model unable to tell whether a half-run migration, install, or
 * build had done anything. Side effects of the command are NOT rolled back,
 * so the partial output is load-bearing for the model's next decision.
 *
 * The first line keeps the historical prefix (`Command aborted` /
 * `Command timed out after`) so existing substring consumers still match.
 * Output is ANSI-stripped and capped to the model budget exactly like the
 * normal completion path, with the full text saved to a capture file when the
 * head+tail view truncated it.
 *
 * Not used for the pre-spawn abort (signal already aborted before the child
 * was started): that command never ran and keeps returning `Command aborted`.
 *
 * @module agent/tools/handlers/bash-interrupted
 */

import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { capForModel } from './_output-cap.js';
import { writeBashCapture } from './_bash-capture.js';

/** Why the command was killed. */
export type BashInterruptKind = 'aborted' | 'timeout';

/** Inputs for {@link interruptedBashResult}. */
export interface BashInterruptInput {
  kind: BashInterruptKind;
  stdout: string;
  stderr: string;
  /** `Date.now()` captured just before spawn. */
  startedAt: number;
  /** The call's configured timeout (used in the timeout headline). */
  timeoutMs: number;
  /** Handler context; only `sessionId` / `toolUseId` are read (capture file). */
  context?: { sessionId?: string | undefined; toolUseId?: string | undefined } | undefined;
}

/** The settle payload shape bash uses for a killed command. */
export interface BashInterruptResult {
  content: string;
  isError: true;
  truncated?: true;
  capturePath?: string;
  durationMs: number;
}

/** Format an elapsed duration as seconds with one decimal (`3.2s`). */
function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/**
 * Build the result for a command killed by abort or timeout, preserving the
 * output it produced before the kill.
 */
export function interruptedBashResult(input: BashInterruptInput): BashInterruptResult {
  const durationMs = Date.now() - input.startedAt;
  const headline = input.kind === 'timeout'
    ? `Command timed out after ${input.timeoutMs}ms`
    : `Command aborted after ${formatSeconds(durationMs)}`;

  const combined = stripEscapeSequences((input.stdout + input.stderr).trimEnd());
  if (combined.length === 0) {
    return {
      content: input.kind === 'timeout'
        ? headline
        : `${headline}; no output was captured before the process was killed`,
      isError: true,
      durationMs,
    };
  }

  const capped = capForModel(combined);
  const capturePath = capped.truncated
    ? writeBashCapture(input.context?.sessionId, input.context?.toolUseId ?? '', combined)
    : undefined;
  return {
    content: `${headline}; the process was killed. Output before the kill:\n${capped.content}`,
    isError: true,
    ...(capped.truncated ? { truncated: true as const } : {}),
    ...(capturePath !== undefined ? { capturePath } : {}),
    durationMs,
  };
}
