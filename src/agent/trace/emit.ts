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
  TraceEventInput,
} from './index.js';

/**
 * Generic emit helper — handles the common pattern of every trace emit
 * function: no-op when writer is absent, write the event, swallow errors
 * with `reportArtifactFailure` on first failure per writer.
 *
 * The `K` parameter is inferred from the `kind` literal, which lets
 * TypeScript narrow the payload type automatically through the
 * {@link TraceEventInput} discriminated union.
 */
async function emitTrace<K extends TraceEventInput['kind']>(
  writer: TraceSink | undefined,
  kind: K,
  payload: Extract<TraceEventInput, { kind: K }>['payload'],
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind, payload } as TraceEventInput);
  } catch (err) {
    reportArtifactFailure('trace.emit', writer, kind, err);
  }
}

export const emitToolCall = (w: TraceSink | undefined, p: ToolCallPayload) =>
  emitTrace(w, 'tool_call', p);

export const emitHookDecision = (w: TraceSink | undefined, p: HookDecisionPayload) =>
  emitTrace(w, 'hook_decision', p);

export const emitSubagentLifecycle = (w: TraceSink | undefined, p: SubagentLifecyclePayload) =>
  emitTrace(w, 'subagent_lifecycle', p);

export const emitBackgroundAgent = (w: TraceSink | undefined, p: BackgroundAgentPayload) =>
  emitTrace(w, 'background_agent', p);

export const emitBudget = (w: TraceSink | undefined, p: BudgetPayload) =>
  emitTrace(w, 'budget', p);

export const emitAbort = (w: TraceSink | undefined, p: AbortPayload) =>
  emitTrace(w, 'abort', p);

export const emitCompaction = (w: TraceSink | undefined, p: CompactionPayloadInput) =>
  emitTrace(w, 'compaction', p);

export const emitClosure = (w: TraceSink | undefined, p: ClosurePayload) =>
  emitTrace(w, 'closure', p);

export const emitClaim = (w: TraceSink | undefined, p: ClaimPayload) =>
  emitTrace(w, 'claim', p);

export const emitBrowserEvent = (w: TraceSink | undefined, p: BrowserEventPayload) =>
  emitTrace(w, 'browser_event', p);

export const emitQueuedUserMessage = (w: TraceSink | undefined, p: QueuedUserMessagePayload) =>
  emitTrace(w, 'queued_user_message', p);

export const emitSessionPhase = (w: TraceSink | undefined, p: SessionPhasePayload) =>
  emitTrace(w, 'session_phase', p);
