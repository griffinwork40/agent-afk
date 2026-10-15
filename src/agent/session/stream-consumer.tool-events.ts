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
import type { ToolEventMin } from '../done-evidence.js';

type ToolUseStartEvent = Extract<ProviderEvent, { type: 'tool.use.start' }>;
type ToolOutputEvent = Extract<ProviderEvent, { type: 'tool.output' }>;

/**
 * The per-turn accumulator fields on `TransformDeps`. The deps object is
 * rebuilt for every turn (`TurnStreamRunner.buildTransformDeps`), so nothing
 * here leaks across turns.
 */
export interface ToolEventAccumulator {
  /** Names of tools that succeeded this turn, in order (daemon Done probe). */
  _successfulToolNames?: string[];
  /** toolUseId -> flattened input captured at `tool.use.start`. */
  _pendingToolInputs?: Map<string, string>;
  /**
   * Every tool call that reported output this turn, successful AND failed, with
   * its real input text. This is what Done-evidence classification reads:
   * `isVerificationCommand` needs the bash command text to recognize
   * `pnpm test` and similar, and failed calls are skipped by the classifier
   * itself via `isError`.
   */
  _turnToolEvents?: ToolEventMin[];
}

/** Remember a tool call's input so its later output can be classified. */
export function recordToolUseStart(acc: ToolEventAccumulator, event: ToolUseStartEvent): void {
  // Pending events carry placeholder input; the settled start event follows.
  if (event.pending || !event.toolName) return;
  (acc._pendingToolInputs ??= new Map()).set(event.toolUseId, event.toolInput);
}

/**
 * Record a finished tool call. Policy-free: which tools count as evidence is
 * decided by the consumer (`done-evidence.ts`), not here. A tool with no name
 * (some synthesized OpenAI Codex events omit it) is skipped.
 */
export function recordToolOutput(acc: ToolEventAccumulator, event: ToolOutputEvent): void {
  if (!event.toolName) return;
  const isError = event.isError === true;
  (acc._turnToolEvents ??= []).push({
    toolName: event.toolName,
    // '' when the input was never captured (unknown id): classifies as a
    // non-verification call, the conservative direction.
    input: acc._pendingToolInputs?.get(event.toolUseId) ?? '',
    isError,
  });
  if (!isError) (acc._successfulToolNames ??= []).push(event.toolName);
}
