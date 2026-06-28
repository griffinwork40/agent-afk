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
  AfkApprovalOutcome,
  AbortOrigin,
  AbortPayload,
  BackgroundAgentCancelledPayload,
  BackgroundAgentCompletedPayload,
  BackgroundAgentFailedPayload,
  BackgroundAgentJoinedPayload,
  BackgroundAgentPayload,
  BackgroundAgentStartedPayload,
  BrowserActAction,
  BrowserEventPayload,
  BrowserEventTarget,
  BrowserEventTool,
  BudgetPayload,
  ClaimPayload,
  ClosurePayload,
  ClosureReason,
  CompactionPayloadInput,
  CompactionPayloadPersisted,
  CompactionSidecarRef,
  CompactionTrigger,
  HookDecisionPayload,
  HookEventName,
  SessionPhasePayload,
  SessionPhaseName,
  SessionSealedPayload,
  SubagentCancelledPayload,
  SubagentFailedPayload,
  SubagentLifecyclePayload,
  SubagentStartedPayload,
  SubagentSucceededPayload,
  ToolCallCompletedPayload,
  ToolCallPayload,
  ToolCallStartedPayload,
  TraceEvent,
  TraceEventInput,
  TraceEventKind,
} from './types.js';

export {
  AbortOriginSchema,
  AbortPayloadSchema,
  BackgroundAgentCancelledPayloadSchema,
  BackgroundAgentCompletedPayloadSchema,
  BackgroundAgentFailedPayloadSchema,
  BackgroundAgentJoinedPayloadSchema,
  BackgroundAgentPayloadSchema,
  BackgroundAgentStartedPayloadSchema,
  BrowserActActionSchema,
  BrowserEventPayloadSchema,
  BrowserEventTargetSchema,
  BrowserEventToolSchema,
  BudgetPayloadSchema,
  ClaimPayloadSchema,
  ClosurePayloadSchema,
  ClosureReasonSchema,
  CompactionPayloadInputSchema,
  CompactionPayloadPersistedSchema,
  CompactionSidecarRefSchema,
  CompactionTriggerSchema,
  HookDecisionPayloadSchema,
  HookEventNameSchema,
  SessionPhaseNameSchema,
  SessionPhasePayloadSchema,
  SessionSealedPayloadSchema,
  SubagentCancelledPayloadSchema,
  SubagentFailedPayloadSchema,
  SubagentLifecyclePayloadSchema,
  SubagentStartedPayloadSchema,
  SubagentSucceededPayloadSchema,
  ToolCallCompletedPayloadSchema,
  ToolCallPayloadSchema,
  ToolCallStartedPayloadSchema,
  TraceEventInputSchema,
  TraceEventSchema,
} from './events.js';

export {
  InMemoryTraceWriter,
  NdjsonTraceWriter,
} from './writer.js';
export type { NdjsonTraceWriterOptions, TraceWriter } from './writer.js';
