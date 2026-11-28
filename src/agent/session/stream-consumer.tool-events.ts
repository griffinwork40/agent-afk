/**
 * Per-turn tool-event accumulation for the stream consumer.
 *
 * Extracted from stream-consumer.ts (one whole concern: recording what tools
 * ran this turn) so `transformProviderEvent`, grandfathered over the
 * function-size ceiling, does not grow.
 *
 * @module agent/session/stream-consumer.tool-events
 */

import type { ProviderEvent } from '../provider.js';
import { isPatchApplyDryRun, type ToolEventMin } from '../done-evidence.js';

type ToolUseStartEvent = Extract<ProviderEvent, { type: 'tool.use.start' }>;
type ToolOutputEvent = Extract<ProviderEvent, { type: 'tool.output' }>;

/**
 * The per-turn accumulator fields on `TransformDeps`. The deps object is
 * rebuilt for every turn (`TurnStreamRunner.buildTransformDeps`), so nothing
 * here leaks across turns.
 */
export interface ToolEventAccumulator {
  /** Successful tool names, excluding patch_apply dry-run previews (daemon Done probe). */
  _successfulToolNames?: string[];
  /** toolUseId -> flattened input captured at `tool.use.start`. */
  _pendingToolInputs?: Map<string, string>;
  /**
   * toolUseId -> raw JSON-serialized tool input (from `extractRawToolInput`).
   * Populated only for tools that carry whitelisted raw fields (e.g. `patch_apply`
   * with its `dry_run` boolean). Used by Done-evidence classification to detect
   * dry-run previews that write nothing.
   */
  _pendingToolInputsRaw?: Map<string, string>;
  /**
   * Every tool call that reported output this turn, successful AND failed, with
   * its real input text. This is what Done-evidence classification reads:
   * `isVerificationCommand` needs the bash command text to recognize
   * `pnpm test` and similar, and failed calls are skipped by the classifier
   * itself via `isError`.
   */
  _turnToolEvents?: ToolEventMin[];
  /**
   * toolUseId -> pre-classified bash booleans captured at `tool.use.start`.
   * Populated only for `bash` calls that carry the flags (set by both provider
   * dispatch sites from the full raw command before 160-char summary truncation).
   * `recordToolOutput` splices these onto the `ToolEventMin` it pushes so
   * `classifyDoneEvidence` reads from the full command, not the truncated summary.
   */
  _pendingToolStarts?: Map<string, { isMutatingBash?: boolean; isVerificationBash?: boolean }>;
}

/** Remember a tool call's input so its later output can be classified. */
export function recordToolUseStart(acc: ToolEventAccumulator, event: ToolUseStartEvent): void {
  // Pending events carry placeholder input; the settled start event follows.
  if (event.pending || !event.toolName) return;
  (acc._pendingToolInputs ??= new Map()).set(event.toolUseId, event.toolInput);
  if (event.toolInputRaw !== undefined) {
    (acc._pendingToolInputsRaw ??= new Map()).set(event.toolUseId, event.toolInputRaw);
  }
  // Capture pre-classified bash booleans so recordToolOutput can splice them
  // onto the ToolEventMin without re-classifying the truncated summary string.
  if (event.isMutatingBash !== undefined || event.isVerificationBash !== undefined) {
    (acc._pendingToolStarts ??= new Map()).set(event.toolUseId, {
      isMutatingBash: event.isMutatingBash,
      isVerificationBash: event.isVerificationBash,
    });
  }
}

/**
 * Record a finished tool call. Keep every event in the full history, but omit
 * patch_apply dry-run previews from the successful-name summary. Consumers
 * still decide which names count as evidence. Nameless synthesized calls are skipped.
 */
export function recordToolOutput(acc: ToolEventAccumulator, event: ToolOutputEvent): void {
  if (!event.toolName) return;
  const isError = event.isError === true;
  const inputRaw = acc._pendingToolInputsRaw?.get(event.toolUseId);
  const pendingStart = acc._pendingToolStarts?.get(event.toolUseId);
  (acc._turnToolEvents ??= []).push({
    toolName: event.toolName,
    // '' when the input was never captured (unknown id): classifies as a
    // non-verification call, the conservative direction.
    input: acc._pendingToolInputs?.get(event.toolUseId) ?? '',
    ...(inputRaw !== undefined ? { inputRaw } : {}),
    ...(pendingStart?.isMutatingBash !== undefined ? { isMutatingBash: pendingStart.isMutatingBash } : {}),
    ...(pendingStart?.isVerificationBash !== undefined ? { isVerificationBash: pendingStart.isVerificationBash } : {}),
    isError,
  });
  const isDryRun = event.toolName === 'patch_apply' &&
    isPatchApplyDryRun({ toolName: event.toolName, input: '', inputRaw });
  if (!isError && !isDryRun) {
    (acc._successfulToolNames ??= []).push(event.toolName);
  }
}
