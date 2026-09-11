/**
 * Ledger payload types and the `projectOutputEvent` projection function.
 *
 * Extracted from session-ledger.ts (Wave 1, Step 1B) so the writer module
 * stays under 350 LOC while the projection grows to carry richer event kinds.
 *
 * @module agent/session-ledger-project
 */

import type { OutputEvent } from './types/session-types.js';
import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

/** One JSONL line in a session ledger. `v` is the schema version. */
export type LedgerRecord = { v: 1; ts: number } & LedgerPayload;

export type LedgerPayload =
  /** Session-level metadata, written once when the ledger opens.
   *  `traceLabel` is the witness-trace directory name (`state/witness/<label>/`)
   *  for this session, letting a reader correlate the id-keyed ledger to the
   *  trace — whose label is a random UUID for fresh sessions, decoupled from
   *  the session id. `null` means no trace was wired (tracing disabled/failed),
   *  making that state explicit rather than a silently-absent directory.
   *  Optional for back-compat with ledgers written before this field existed. */
  | {
      kind: 'meta';
      sessionId: string;
      model: string;
      cwd?: string;
      surface?: string;
      traceLabel?: string | null;
    }
  /** A user turn entering the session (summary text, never raw blocks). */
  | { kind: 'user'; text: string }
  /** A complete assistant message. */
  | { kind: 'assistant'; text: string }
  /** Extended-thinking block (clipped). */
  | { kind: 'thinking'; text: string }
  /** A tool invocation starting. `input` is a preview, capped at source. */
  | { kind: 'tool'; toolName: string; toolUseId?: string; input: string }
  /** A failed tool result. */
  | { kind: 'tool_error'; toolName?: string; content: string }
  /** A successful tool result (clipped). */
  | { kind: 'tool_result'; toolUseId: string; content: string; durationMs?: number; toolName?: string }
  /** Turn completed. Cost/duration/token breakdown when the provider reported them. */
  | { kind: 'done'; costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; stopReason?: string }
  /** Stream-level error. Message only — Error objects don't survive JSON. */
  | { kind: 'error'; message: string }
  /** Provider paused on a usage limit. */
  | { kind: 'paused'; resetsAt?: string }
  /** Provider resumed after a usage-limit pause. */
  | { kind: 'resumed' }
  /** Live tool-activity marker. */
  | { kind: 'tool_activity'; activeCount: number; activeToolUseIds: string[] }
  /** Provider rate-limit backoff in progress. */
  | { kind: 'rate_limit'; retryAfterMs?: number }
  /** Subagent progress summary. */
  | { kind: 'progress'; message: string }
  /** Subagent lifecycle transition (Wave 0-C / Wave 1). */
  | {
      kind: 'subagent_lifecycle';
      subagentId: string;
      status: string;
      model?: string;
      agentType?: string;
      durationMs?: number;
      totalCostUsd?: number;
      outputBytes?: number;
      errorClass?: string;
      errorMessage?: string;
      promptHead?: string;
      /** Number of turns completed (present on succeeded events). */
      turnCount?: number;
      /** Provider stop reason from the last turn (present on succeeded events). */
      stopReason?: string;
      /**
       * tool_use_id of the dispatching `agent`/`compose` call — links a subagent
       * to the tool row that spawned it for topology rendering. Present on 'started'
       * events only.
       */
      parentToolUseId?: string;
    }
  /** Background-job state transition (Wave 0-C / Wave 1). */
  | { kind: 'background_job'; jobId: string; status: string; label?: string }
  /** Plan-mode transition (Wave 0-C / Wave 1). */
  | { kind: 'plan_mode'; mode: string }
  // Invariant: the three AFK remote-control records below carry the
  // cross-process elicitation/abort protocol (REPL session <-> Telegram daemon)
  // over the same ledger file. `elicitation` is written by the REPL when the
  // agent asks a question while AFK; `elicitation_response` and `abort_request`
  // are written BACK by the daemon and MUST carry a per-session HMAC (see
  // afk-channel.ts) — the REPL refuses any whose signature does not verify, so a
  // stray or cross-session write can never resolve a question or abort a turn.
  /** AFK: the agent asked a question; `reqId` correlates the response. */
  | { kind: 'elicitation'; reqId: string; request: ElicitationRequest }
  /** AFK: an answer to a prior `elicitation`, signed by the daemon. */
  | { kind: 'elicitation_response'; reqId: string; result: ElicitationResult; hmac: string }
  /** AFK: a signed request to abort the running turn. */
  | { kind: 'abort_request'; nonce: string; hmac: string }
  /** Terminal record: the hosting process closed the session. */
  | { kind: 'closed'; reason?: string };

/** Cap stored user/assistant/thinking text so a pasted file can't bloat the ledger. */
export const MAX_TEXT_LEN = 8_000;
/** Cap stored tool-input previews and tool result content. */
export const MAX_TOOL_INPUT_LEN = 400;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/**
 * Project an `OutputEvent` onto a ledger payload, or `null` for events the
 * ledger intentionally skips (text/thinking deltas, suggestions, stream-retry
 * markers, panel payloads).
 */
export function projectOutputEvent(event: OutputEvent): LedgerPayload | null {
  switch (event.type) {
    case 'message':
      if (event.message.role !== 'assistant' || !event.message.content) return null;
      return { kind: 'assistant', text: clip(event.message.content, MAX_TEXT_LEN) };
    case 'chunk': {
      const chunk = event.chunk;
      if (chunk.type === 'tool_use_detail') {
        // Skip the pending paint: anthropic-direct announces each call twice and
        // the first carries a placeholder for `toolInput`, so recording it wrote
        // every tool twice at rest. openai-compatible emits only the completed event.
        if (chunk.pending) return null;
        return { kind: 'tool', toolName: chunk.toolName, toolUseId: chunk.toolUseId, input: clip(chunk.toolInput, MAX_TOOL_INPUT_LEN) };
      }
      if (chunk.type === 'tool_result') {
        if (chunk.isError === true) {
          return {
            kind: 'tool_error',
            content: clip(chunk.content, MAX_TOOL_INPUT_LEN),
            ...(chunk.metadata?.['toolName'] !== undefined ? { toolName: String(chunk.metadata['toolName']) } : {}),
          };
        }
        // Successful tool results — persist a clipped preview so the web UI can
        // show real output instead of "unavailable after refresh".
        return {
          kind: 'tool_result',
          toolUseId: chunk.toolUseId,
          content: clip(chunk.content, MAX_TOOL_INPUT_LEN),
          ...(typeof chunk.durationMs === 'number' ? { durationMs: chunk.durationMs } : {}),
          ...(chunk.metadata?.['toolName'] !== undefined ? { toolName: String(chunk.metadata['toolName']) } : {}),
        };
      }
      if (chunk.type === 'thinking') {
        return { kind: 'thinking', text: clip(chunk.content, MAX_TEXT_LEN) };
      }
      return null;
    }
    case 'done': {
      const meta = event.metadata;
      const cost = meta?.totalCostUsd;
      const duration = meta?.durationMs;
      const usage = meta?.usage as Record<string, unknown> | undefined;
      const inputTokens = typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] : undefined;
      const outputTokens = typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] : undefined;
      const cacheReadTokens = typeof usage?.['cache_read_input_tokens'] === 'number' ? usage['cache_read_input_tokens'] : undefined;
      const stopReason = typeof meta?.stopReason === 'string' ? meta.stopReason : undefined;
      return {
        kind: 'done',
        ...(typeof cost === 'number' ? { costUsd: cost } : {}),
        ...(typeof duration === 'number' ? { durationMs: duration } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
      };
    }
    case 'error':
      return { kind: 'error', message: event.error.message };
    case 'paused':
      return { kind: 'paused', ...(event.resetsAt ? { resetsAt: event.resetsAt.toISOString() } : {}) };
    case 'resumed':
      return { kind: 'resumed' };
    case 'notice':
      // Display-only harness notice (issue #970). Skipped from the ledger.
      return null;
    case 'tool-activity':
      return { kind: 'tool_activity', activeCount: event.activeCount, activeToolUseIds: event.activeToolUseIds };
    case 'rate_limit':
      return { kind: 'rate_limit', ...(typeof event.retryAfterMs === 'number' ? { retryAfterMs: event.retryAfterMs } : {}) };
    case 'progress':
      return { kind: 'progress', message: event.progress.summary ?? event.progress.description };
    case 'subagent_lifecycle':
      return {
        kind: 'subagent_lifecycle',
        subagentId: event.subagentId,
        status: event.status,
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.agentType !== undefined ? { agentType: event.agentType } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.totalCostUsd !== undefined ? { totalCostUsd: event.totalCostUsd } : {}),
        ...(event.outputBytes !== undefined ? { outputBytes: event.outputBytes } : {}),
        ...(event.errorClass !== undefined ? { errorClass: event.errorClass } : {}),
        ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
        ...(event.promptHead !== undefined ? { promptHead: event.promptHead } : {}),
        ...(event.turnCount != null ? { turnCount: event.turnCount } : {}),
        ...(event.stopReason ? { stopReason: event.stopReason } : {}),
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      };
    case 'background_job':
      return {
        kind: 'background_job',
        jobId: event.jobId,
        status: event.status,
        ...(event.label !== undefined ? { label: event.label } : {}),
      };
    case 'plan_mode':
      return { kind: 'plan_mode', mode: event.mode };
    default:
      // suggestion | stream_retry | panel — intentionally skipped.
      return null;
  }
}
