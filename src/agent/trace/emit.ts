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
 *      completely broken. The `writer` INSTANCE itself is the dedup key,
 *      matched by identity (see `reportArtifactFailure`'s `WeakMap`) rather
 *      than by calling a trace-path accessor on it — a partial/test-double
 *      writer need not implement that accessor, and the in-memory writer
 *      returns the same sentinel path for every instance, so a path-derived
 *      key was neither safe nor unique. Identity requires no `sessionId`
 *      parameter on these functions and needs no plumbing through any of
 *      the twelve call sites below.
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
  TraceSink,
} from './index.js';

export async function emitToolCall(
  writer: TraceSink | undefined,
  payload: ToolCallPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'tool_call', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'tool_call', err);
  }
}

export async function emitHookDecision(
  writer: TraceSink | undefined,
  payload: HookDecisionPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'hook_decision', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'hook_decision', err);
  }
}

export async function emitSubagentLifecycle(
  writer: TraceSink | undefined,
  payload: SubagentLifecyclePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'subagent_lifecycle', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'subagent_lifecycle', err);
  }
}

export async function emitBackgroundAgent(
  writer: TraceSink | undefined,
  payload: BackgroundAgentPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'background_agent', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'background_agent', err);
  }
}

export async function emitBudget(
  writer: TraceSink | undefined,
  payload: BudgetPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'budget', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'budget', err);
  }
}

export async function emitAbort(
  writer: TraceSink | undefined,
  payload: AbortPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'abort', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'abort', err);
  }
}

export async function emitCompaction(
  writer: TraceSink | undefined,
  payload: CompactionPayloadInput,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'compaction', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'compaction', err);
  }
}

export async function emitClosure(
  writer: TraceSink | undefined,
  payload: ClosurePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'closure', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'closure', err);
  }
}

export async function emitClaim(
  writer: TraceSink | undefined,
  payload: ClaimPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'claim', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'claim', err);
  }
}

export async function emitBrowserEvent(
  writer: TraceSink | undefined,
  payload: BrowserEventPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'browser_event', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'browser_event', err);
  }
}

export async function emitQueuedUserMessage(
  writer: TraceSink | undefined,
  payload: QueuedUserMessagePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'queued_user_message', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'queued_user_message', err);
  }
}

export async function emitSessionPhase(
  writer: TraceSink | undefined,
  payload: SessionPhasePayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'session_phase', payload });
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, 'session_phase', err);
  }
}
