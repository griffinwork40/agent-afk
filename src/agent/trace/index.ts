/**
 * Witness-layer trace module — public surface.
 *
 * The runtime owes the operator surviving evidence of unattended work.
 * This module is where that evidence is shaped, validated, and persisted.
 *
 * See `docs/philosophy/afk-contract.md` for the contract this module
 * makes enforceable, and `src/agent/trace/types.ts` for the per-event
 * payload taxonomy.
 *
 * @module agent/trace
 */

export type {
  AbortOrigin,
  BackgroundAgentPayload,
  ClosureReason,
  HookEventName,
  SessionPhasePayload,
  SubagentLifecyclePayload,
  TraceEvent,
  TraceEventInput,
} from './types.js';

export {
  InMemoryTraceWriter,
} from './writer.js';
export type { TraceSink, TraceWriter } from './writer.js';
