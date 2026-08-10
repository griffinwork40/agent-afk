/**
 * Thin emit helpers for trace events.
 *
 * Wraps {@link TraceWriter.write} with two policies:
 *
 *   1. **No-op when writer is undefined.** Emission sites never need to
 *      guard with `if (writer)` — call the helper unconditionally.
 *
 *   2. **Errors are swallowed but not silent (#850).** A broken trace
 *      writer must never crash an active session, so every failure is
 *      caught here — but the FIRST failure per writer is also surfaced to
 *      stderr unconditionally via `reportArtifactFailure` (subsequent
 *      failures for the same writer fall back to `debugLog`), so an
 *      operator who turns on tracing does not get silence when it is
 *      completely broken. `traceDedupKey(writer)` is the dedup key: it is
 *      unique per session/writer instance and these functions take no
 *      `sessionId` parameter, so it identifies "this failing sink" without
 *      threading a new parameter through eleven call sites.
 *
 * This keeps emission sites readable — no try/catch noise around every
 * trace write — while preserving the invariant that the witness layer
 * is observational and must not interfere with the primary work.
 *
 * @module agent/trace/emit
 */

import { reportArtifactFailure } from '../../utils/artifact-failure-reporter.js';
import type {
  AbortPayload,
  BackgroundAgentPayload,
  BrowserEventPayload,
  BudgetPayload,
  ClaimPayload,
  ClosurePayload,
  CompactionPayloadInput,
  HookDecisionPayload,
  QueuedUserMessagePayload,
  SessionPhasePayload,
  SubagentLifecyclePayload,
  ToolCallPayload,
  TraceWriter,
} from './index.js';

// Contract: this derivation runs INSIDE a catch block, so it must never throw.
// `reportArtifactFailure` guards its own body, but its arguments are evaluated
// before it is entered — so calling `traceDedupKey(writer)` directly at the
// call site put the one unguarded expression on the failure path. A writer
// double, or a partial TraceWriter from an SDK consumer, that lacks the method
// then converted a swallowed write failure into an unhandled rejection: the
// diagnostic becoming the failure it reports, which is precisely the
// never-throw contract this reporter exists to uphold (#850).
function traceDedupKey(writer: TraceWriter): string {
  try {
    return typeof writer.getTracePath === 'function' ? traceDedupKey(writer) : 'unknown-trace';
  } catch {
    return 'unknown-trace';
  }
}

export async function emitToolCall(
  writer: TraceWriter | undefined,
  payload: ToolCallPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'tool_call', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'tool_call', err);
  }
}

export async function emitHookDecision(
  writer: TraceWriter | undefined,
  payload: HookDecisionPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'hook_decision', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'hook_decision', err);
  }
}

export async function emitSubagentLifecycle(
  writer: TraceWriter | undefined,
  payload: SubagentLifecyclePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'subagent_lifecycle', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'subagent_lifecycle', err);
  }
}

export async function emitBackgroundAgent(
  writer: TraceWriter | undefined,
  payload: BackgroundAgentPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'background_agent', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'background_agent', err);
  }
}

export async function emitBudget(
  writer: TraceWriter | undefined,
  payload: BudgetPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'budget', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'budget', err);
  }
}

export async function emitAbort(
  writer: TraceWriter | undefined,
  payload: AbortPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'abort', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'abort', err);
  }
}

export async function emitCompaction(
  writer: TraceWriter | undefined,
  payload: CompactionPayloadInput,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'compaction', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'compaction', err);
  }
}

export async function emitClosure(
  writer: TraceWriter | undefined,
  payload: ClosurePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'closure', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'closure', err);
  }
}

export async function emitClaim(
  writer: TraceWriter | undefined,
  payload: ClaimPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'claim', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'claim', err);
  }
}

export async function emitBrowserEvent(
  writer: TraceWriter | undefined,
  payload: BrowserEventPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'browser_event', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'browser_event', err);
  }
}

export async function emitQueuedUserMessage(
  writer: TraceWriter | undefined,
  payload: QueuedUserMessagePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'queued_user_message', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'queued_user_message', err);
  }
}

export async function emitSessionPhase(
  writer: TraceWriter | undefined,
  payload: SessionPhasePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'session_phase', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', traceDedupKey(writer), 'session_phase', err);
  }
}
