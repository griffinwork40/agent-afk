/**
 * JSON output builder for `afk chat -f json`.
 *
 * Extracted from `chat.ts` to keep that file within the 350-code-line ceiling.
 * The `buildOneShotJsonOutput` helper assembles the full payload including
 * the trace-identity fields (`sessionId`, `witnessLabel`, `tracePath`) added
 * by issue #1538 — enabling headless runners to locate the witness record
 * without racing against concurrent sessions via `ls -t`.
 *
 * @module cli/commands/chat.json-output
 */

import type { ResponseMetadata } from '../../agent/types.js';

export interface OneShotJsonOutputOpts {
  sessionModel: string;
  responseContent: string;
  responseTimestamp: Date | undefined;
  responseMeta: ResponseMetadata | null;
  /** Session identifier (from the AgentSession). Conditionally present. */
  sessionId?: string;
  /** Witness directory label (basename of the trace dir). Conditionally present. */
  witnessLabel?: string;
  /** Absolute path to the trace.jsonl file. Conditionally present. */
  tracePath?: string;
}

/**
 * Build the JSON payload for `afk chat -f json`.
 *
 * All four metadata fields (`costUsd`, `durationMs`, `inputTokens`,
 * `outputTokens`) are best-effort and omitted when zero or absent.
 * The three trace-identity fields are omitted when tracing is disabled
 * (`AFK_TRACE_DISABLED=1`) or when the field is not available.
 */
export function buildOneShotJsonOutput(
  opts: OneShotJsonOutputOpts,
): Record<string, unknown> {
  const {
    sessionModel, responseContent, responseTimestamp, responseMeta,
    sessionId, witnessLabel, tracePath,
  } = opts;
  const inputTokens = responseMeta ? Number(responseMeta.usage?.['input_tokens'] ?? 0) : 0;
  const outputTokens = responseMeta ? Number(responseMeta.usage?.['output_tokens'] ?? 0) : 0;
  return {
    success: true,
    model: sessionModel,
    message: responseContent,
    timestamp: responseTimestamp,
    ...(responseMeta?.totalCostUsd !== undefined ? { costUsd: responseMeta.totalCostUsd } : {}),
    ...(responseMeta?.durationMs !== undefined ? { durationMs: responseMeta.durationMs } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    // Trace identity (#1538): headless runners use these to locate the witness
    // record without racing against concurrent sessions via ls -t.
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(witnessLabel !== undefined ? { witnessLabel } : {}),
    ...(tracePath !== undefined ? { tracePath } : {}),
  };
}
