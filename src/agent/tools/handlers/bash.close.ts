/**
 * Normal-completion `close` handler for the bash handler.
 *
 * Handles the `proc.on('close', ...)` event: deregisters the detach token,
 * handles the abort-beats-close race, formats non-zero exit results, detects
 * test-runner output, and applies the model-facing head+tail cap.
 *
 * Extracted from `createBashHandler` so that function stays under the 200-line
 * ceiling. All inputs are explicit parameters; no closures over hidden locals.
 *
 * @module agent/tools/handlers/bash.close
 */

import type { ToolHandlerContext } from '../types.js';
import type { OverflowState } from './bash.overflow.js';
import { detectTestResult } from './test-runner-detector.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { capForModel } from './_output-cap.js';
import { writeBashCapture } from './_bash-capture.js';
import { interruptedBashResult } from './bash-interrupted.js';

/** Parameters for {@link handleClose}. */
export interface HandleCloseParams {
  code: number | null;
  state: OverflowState;
  signal: AbortSignal;
  context: ToolHandlerContext | undefined;
  startedAt: number;
  timeout_ms: number;
  deregisterOnClose: (() => void) | undefined;
  settle: (result: { content: string; isError?: boolean; truncated?: boolean; capturePath?: string; durationMs?: number; exitCode?: number; testResult?: import('./test-runner-detector.js').TestResult }) => void;
}

/**
 * Handle the `close` event emitted after all stdio streams drain.
 *
 * Invariant: `settle()` is idempotent (guards on `resolved`), so calling it
 * when the abort or overflow path already fired is a safe no-op.
 */
export function handleClose(params: HandleCloseParams): void {
  const { code, state, signal, context, startedAt, timeout_ms, settle } = params;

  // Fix #2: free registry slot on normal-close path. deregister() is idempotent;
  // on the detach path, deregisterOnClose is undefined so this is a safe no-op.
  params.deregisterOnClose?.();

  // If the process was killed by our abort handler, `settle` already ran
  // (resolved=true) so this call is a no-op. Check anyway so the branch is
  // explicit: abort beats close.
  if (signal.aborted) {
    settle(interruptedBashResult({ kind: 'aborted', stdout: state.stdout, stderr: state.stderr, startedAt, timeoutMs: timeout_ms, context }));
    return;
  }

  if (code !== null && code !== 0) {
    // Non-zero exit: name the failure mode and include collected output.
    const rawErr = state.stderr.trimEnd() || state.stdout.trimEnd();
    const capped = capForModel(rawErr);
    const elapsed = Date.now() - startedAt;
    const capturePath = capped.truncated
      ? writeBashCapture(context?.sessionId, context?.toolUseId ?? '', rawErr)
      : undefined;
    settle({
      content: `Command exited with code ${code}${capped.content ? '\n' + capped.content : ''}`,
      isError: true,
      ...(capped.truncated ? { truncated: true } : {}),
      ...(capturePath !== undefined ? { capturePath } : {}),
      durationMs: elapsed,
      exitCode: code,
    });
    return;
  }

  // Overflow path already settled before the SIGKILL → close round-trip.
  if (state.overflowKilled) return;

  const combined = stripEscapeSequences((state.stdout + state.stderr).trimEnd());

  // Detect test-runner results BEFORE truncation so patterns near the end of
  // long output are not missed.
  const testResult = detectTestResult(combined) ?? undefined;

  const capped = capForModel(combined);
  const elapsed = Date.now() - startedAt;
  const capturePath = capped.truncated
    ? writeBashCapture(context?.sessionId, context?.toolUseId ?? '', combined)
    : undefined;
  settle({
    content: capped.content,
    ...(capped.truncated ? { truncated: true } : {}),
    ...(capturePath !== undefined ? { capturePath } : {}),
    durationMs: elapsed,
    ...(code !== null ? { exitCode: code } : {}),
    ...(testResult !== undefined ? { testResult } : {}),
  });
}
