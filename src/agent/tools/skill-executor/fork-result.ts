/**
 * Outcome rendering for a forked skill: `SubagentResult` → `ToolResult`.
 *
 * Extracted from `fork-dispatch.ts`'s `runForkedSkillToResult` so the triage is
 * a pure function with no fork, teardown, or credential wiring around it —
 * every branch is directly unit-testable, and the dispatch driver keeps one job
 * (fork → run → teardown) instead of also owning presentation.
 *
 * Contract: the returned `ToolResult` is what the MODEL sees for a `skill` call.
 * Three outcomes, in priority order:
 *   1. `succeeded` with a message → the child's content, annotated when the
 *      result is itself an incomplete partial (turn cap / stream truncation).
 *   2. produced text but did not finish cleanly → the text, behind a marker
 *      naming why it is partial. Covers BOTH `cancelled` (user interrupt) and
 *      `failed` (own-budget timeout, idle-watchdog abort) — see the invariant
 *      on {@link renderForkOutcome}.
 *   3. no usable text → the error message, `isError: true`.
 * `incompleteToolResultFields` rides along on every branch so non-model
 * consumers get the structured `incomplete`/`incompleteReason` counterpart to
 * whatever banner the model sees (no-op for a clean stopReason).
 *
 * @module agent/tools/skill-executor/fork-result
 */

import { annotateIfIncomplete, incompleteToolResultFields } from '../../subagent/result.js';
import type { SubagentResult } from '../../subagent/result.js';
import { capForModel } from '../handlers/_output-cap.js';
import type { ToolResult } from '../types.js';

/** Marker prefix for output preserved off a user/parent cancellation. */
export const CANCELLED_PARTIAL_MARKER =
  '[skill cancelled mid-flight — partial output preserved below]';

/** Build the marker for output preserved off a failure, naming the failure. */
export function failedPartialMarker(errorMessage: string): string {
  return `[skill failed: ${errorMessage} — partial output preserved below]`;
}

/** Non-empty streamed text from a fork that did not complete, or `undefined`. */
function usablePartial(result: SubagentResult): string | undefined {
  const partial = result.partialOutput;
  return typeof partial === 'string' && partial.length > 0 ? partial : undefined;
}

/** Preserve partial text without allowing a failed fork to flood the parent context. */
function renderPartial(marker: string, partial: string): Pick<ToolResult, 'content' | 'truncated'> {
  const capped = capForModel(`${marker}\n\n${partial}`);
  return {
    content: capped.content,
    ...(capped.truncated ? { truncated: true } : {}),
  };
}

/**
 * Render a finished fork's result into the tool result the model receives.
 *
 * Invariant: a fork that produced text must never return that text-free. The
 * runtime attaches whatever content the child streamed before it died
 * (`subagent/handle.ts`), and BOTH non-clean terminal statuses can carry it:
 * `cancelled` for a user/parent interrupt, and `failed` for an own-budget
 * wall-clock timeout or an idle-watchdog abort. Rendering only the `cancelled`
 * case — the behaviour before this function existed — meant a fork killed by
 * its own budget returned a bare "Operation timed out after Nms" with every
 * finding discarded, which is precisely what makes bounding a skill fork's
 * runtime unsafe. `isError` stays `true` on the failed path (the skill DID
 * fail) and the marker names the failure, so preserved output can never be
 * misread as a complete result. The `agent` tool already surfaces partial
 * output on failure via `tools/subagent/failure-payload.ts`; this brings the
 * skill-fork path into line with it.
 *
 * @param result          terminal result from `handle.runToResult`
 * @param noOutputError   fallback message when the child carried no error
 */
export function renderForkOutcome(result: SubagentResult, noOutputError: string): ToolResult {
  if (result.status === 'succeeded' && result.message) {
    return {
      content: annotateIfIncomplete(result.message.content, result.stopReason),
      ...incompleteToolResultFields(result.stopReason),
    };
  }

  const partial = usablePartial(result);

  if (result.status === 'cancelled' && partial !== undefined) {
    return {
      ...renderPartial(CANCELLED_PARTIAL_MARKER, partial),
      ...incompleteToolResultFields(result.stopReason),
    };
  }

  const errorMessage = result.error?.message ?? noOutputError;

  if (partial !== undefined) {
    return {
      ...renderPartial(failedPartialMarker(errorMessage), partial),
      isError: true,
      ...incompleteToolResultFields(result.stopReason),
    };
  }

  return {
    content: errorMessage,
    isError: true,
    ...incompleteToolResultFields(result.stopReason),
  };
}
