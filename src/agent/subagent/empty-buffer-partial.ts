/**
 * Helpers for the empty-buffer stream-cut path in {@link SubagentHandleImpl}.
 *
 * When a subagent's model stream ends with NO terminal message AND an EMPTY
 * streamed text buffer, the run classifies as `failed` (via a thrown
 * {@link StreamIncompleteError}). If tool-call cycles completed before the
 * cut (read_file, bash, grep, …), that gathered evidence is not lost — it
 * lives in the handle's `currentTrace.toolResults`. This module synthesizes
 * a human-readable `partialOutput` summary and the typed error so the parent
 * can distinguish "died with N gathered results" from "died with nothing".
 *
 * @module agent/subagent/empty-buffer-partial
 */

import { StreamIncompleteError } from '../../utils/errors.js';
import type { SubagentToolResult } from './result.js';

/**
 * Build the {@link StreamIncompleteError} for the empty-buffer stream-cut
 * path, with `toolResultsGathered` populated when prior tool results exist.
 */
export function buildEmptyBufferError(
  subagentId: string,
  toolResults: SubagentToolResult[],
): StreamIncompleteError {
  const n = toolResults.length;
  const msg =
    n > 0
      ? `subagent ${subagentId} stream cut off after ${n} tool result(s); see partialOutput.`
      : `subagent ${subagentId} produced no output — stream ended without a terminal ` +
        `message (stream_incomplete). No findings were produced; retry or fall back.`;
  const err = new StreamIncompleteError(msg);
  if (n > 0) err.toolResultsGathered = n;
  return err;
}

/**
 * Synthesize a `partialOutput` string from accumulated tool results when a
 * stream cut off before any assistant text was produced.
 *
 * Returns `undefined` when there are no tool results (caller should omit
 * `partialOutput` from the result in that case).
 */
export function synthesizeEmptyBufferPartial(
  subagentId: string,
  toolResults: SubagentToolResult[],
): string | undefined {
  if (toolResults.length === 0) return undefined;
  const totalBytes = toolResults.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
  const errorCount = toolResults.filter((r) => r.isError).length;
  const errorSuffix = errorCount > 0 ? ` (${errorCount} errored)` : '';
  return (
    `[Stream cut off before any assistant text was produced. ` +
    `Subagent ${subagentId} completed ${toolResults.length} tool result(s)${errorSuffix} ` +
    `(~${totalBytes} bytes total) before the cut. ` +
    `The run is failed — no final answer was produced — but tool evidence is ` +
    `available via result.trace for recovery or retry decisions.]`
  );
}
