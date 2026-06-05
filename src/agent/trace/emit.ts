/**
 * Thin emit helpers for trace events.
 *
 * Wraps {@link TraceWriter.write} with two policies:
 *
 *   1. **No-op when writer is undefined.** Emission sites never need to
 *      guard with `if (writer)` — call the helper unconditionally.
 *
 *   2. **Errors are swallowed.** A broken trace writer must never crash
 *      an active session. Failures are logged via `debugLog` so they
 *      surface during debugging but never propagate to the caller.
 *
 * This keeps emission sites readable — no try/catch noise around every
 * trace write — while preserving the invariant that the witness layer
 * is observational and must not interfere with the primary work.
 *
 * @module agent/trace/emit
 */

import { debugLog } from '../../utils/debug.js';
import type {
  AbortPayload,
  BackgroundAgentPayload,
  BrowserEventPayload,
  BudgetPayload,
  ClaimPayload,
  ClosurePayload,
  CompactionPayloadInput,
  HookDecisionPayload,
  SessionPhasePayload,
  SubagentLifecyclePayload,
  ToolCallPayload,
  TraceWriter,
} from './index.js';

export async function emitToolCall(
  writer: TraceWriter | undefined,
  payload: ToolCallPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'tool_call', payload });
  } catch (err) {
    debugLog(`trace.emit tool_call failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit hook_decision failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit subagent_lifecycle failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit background_agent failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit budget failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit abort failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit compaction failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit closure failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit claim failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit browser_event failed: ${stringifyError(err)}`);
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
    debugLog(`trace.emit session_phase failed: ${stringifyError(err)}`);
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
