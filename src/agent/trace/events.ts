/**
 * Zod runtime schemas for trace event payloads.
 *
 * The TypeScript types in {@link ./types} are the canonical shape; this
 * module mirrors them as Zod schemas so:
 *
 *   1. The writer can validate event input at the boundary, catching
 *      shape drift before it lands on disk.
 *   2. Readers (`afk show`, `afk tail`, future replay tools) can parse
 *      a JSONL file from an older runtime version and reject malformed
 *      lines without crashing.
 *
 * The schemas are exported individually for granular use, and as a single
 * `TraceEventSchema` discriminated union for whole-event validation.
 *
 * @module agent/trace/events
 */

import { z } from 'zod';
import { TOOL_FAILURE_CLASSES } from './types.js';
import { BackgroundAgentCancelledPayloadSchema } from './background-agent-schema.js';
import { BrowserEventPayloadSchema } from './events.browser.js';
import { CompactionPayloadInputSchema, CompactionPayloadPersistedSchema } from './events.compaction.js';
import { SessionPhasePayloadSchema } from './events.session-phase.js';

export { BackgroundAgentCancelledPayloadSchema } from './background-agent-schema.js';
export {
  BrowserEventToolSchema,
  BrowserActActionSchema,
  BrowserEventTargetSchema,
  BrowserEventPayloadSchema,
} from './events.browser.js';
export {
  CompactionTriggerSchema,
  CompactionSidecarRefSchema,
  CompactionPayloadInputSchema,
  CompactionPayloadPersistedSchema,
} from './events.compaction.js';
export { SessionPhaseNameSchema, SessionPhasePayloadSchema } from './events.session-phase.js';

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

export const ToolCallStartedPayloadSchema = z.object({
  phase: z.literal('started'),
  toolUseId: z.string(),
  name: z.string(),
  inputBytes: z.number().int().nonnegative(),
  /** Optional for backward compat: traces recorded before this field was
   *  added lack it. New traces always produce it (SHA-256 hex = 64 chars). */
  argsFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** SHA-256 of the normalized resource id (path without offset/limit). Resource-bearing tools only. */
  resourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  subagentId: z.string().optional(),
});

/** Mirrors {@link import('./types.js').ToolFailureClass}. The literal tuple is
 *  imported from `types.ts` (the canonical source) so the validator and the TS
 *  type cannot drift. */
export const ToolFailureClassSchema = z.enum(TOOL_FAILURE_CLASSES);

export const ToolCallCompletedPayloadSchema = z.object({
  phase: z.literal('completed'),
  toolUseId: z.string(),
  name: z.string(),
  resultBytes: z.number().int().nonnegative(),
  isError: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  /** True when this result carries a subagent's capped/stream-cut partial
   *  answer. Mirrors `ToolResult.incomplete`. Absent otherwise. */
  incomplete: z.boolean().optional(),
  /** The subagent stopReason that produced `incomplete: true`. Present only
   *  alongside `incomplete: true`; absent otherwise. */
  incompleteReason: z.string().optional(),
  /** Set when the event was produced by the repeat-loop circuit breaker. */
  circuitBreaker: z.boolean().optional(),
  /** Coarse failure classification when `isError` is true. Absent otherwise. */
  failureClass: ToolFailureClassSchema.optional(),
  /** Concurrency-batch membership (1-based index + total size). `batchSize > 1`
   *  ⇒ ran in a parallel wave; `=== 1` ⇒ ran alone. Absent on the single-tool
   *  `execute()` path and on blocked/short-circuited calls. */
  batchIndex: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().optional(),
  subagentId: z.string().optional(),
  /** First ≤200 code points of error text (redacted; all C0/DEL/C1 control
   *  characters collapsed to spaces). Present only when `isError` is true and
   *  the content string is non-empty. Old traces that lack this field continue
   *  to validate. See `ERROR_HEAD_CAP` / `buildErrorHead` in
   *  src/agent/providers/shared/tool-call-trace.ts for the exact build logic. */
  errorHead: z.string().optional(),
});

export const ToolCallPayloadSchema = z.discriminatedUnion('phase', [
  ToolCallStartedPayloadSchema,
  ToolCallCompletedPayloadSchema,
]);

// ---------------------------------------------------------------------------
// hook_decision
// ---------------------------------------------------------------------------

export const HookEventNameSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
]);

export const HookDecisionPayloadSchema = z.object({
  hookEvent: HookEventNameSchema,
  // Invariant: `decision` is absent on the wire for the pass-through case —
  // the writer sets it to `undefined`, and JSON.stringify drops undefined-valued
  // keys, so a persisted line has no `decision` key at all. `.optional()` (not a
  // `z.undefined()` union member) is required: zod ≥4.4 treats a union-with-undefined
  // field as nonoptional and rejects a MISSING key, which silently invalidated
  // every pass-through hook_decision line in `afk improve scan`.
  decision: z.union([z.literal('block'), z.literal('approve')]).optional(),
  reason: z.string().optional(),
  blockedTool: z.string().optional(),
  /** Present when the decision was made inside a fork; absent at top level. */
  subagentId: z.string().optional(),
  injectedContextBytes: z.number().int().nonnegative().optional(),
  /** Set only by the AFK high-risk approval gate. Wall-clock ms from gate entry to decision. */
  durationMs: z.number().nonnegative().optional(),
  /** Set only by the AFK high-risk approval gate. Fine-grained approval outcome. */
  approvalOutcome: z
    .enum(['carve-out', 'approved', 'denied', 'unrecognised', 'timeout', 'decline', 'cancel', 'hard-block'])
    .optional(),
});

// ---------------------------------------------------------------------------
// subagent_lifecycle
// ---------------------------------------------------------------------------

export const SubagentStartedPayloadSchema = z.object({
  transition: z.literal('started'),
  subagentId: z.string(),
  parentId: z.string(),
  model: z.string(),
  allowedTools: z.array(z.string()).readonly().optional(),
  systemPromptHash: z.string().optional(),
  promptHead: z.string().optional(),
  agentType: z.string().optional(),
  resolvedAgentType: z.string().optional(),
  maxToolUseIterations: z.number().int().nonnegative().optional(),
});

export const SubagentSucceededPayloadSchema = z.object({
  transition: z.literal('succeeded'),
  subagentId: z.string(),
  durationMs: z.number().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative(),
  stopReason: z.string().optional(),
});

export const SubagentFailedPayloadSchema = z.object({
  transition: z.literal('failed'),
  subagentId: z.string(),
  errorClass: z.string(),
  errorMessage: z.string(),
  partialOutputBytes: z.number().int().nonnegative(),
  failureClass: ToolFailureClassSchema.optional(),
});

export const SubagentCancelledPayloadSchema = z.object({
  transition: z.literal('cancelled'),
  subagentId: z.string(),
  source: z.enum(['cascade', 'explicit']),
  timeout: z.boolean().optional(),
});

export const SubagentLifecyclePayloadSchema = z.discriminatedUnion('transition', [
  SubagentStartedPayloadSchema,
  SubagentSucceededPayloadSchema,
  SubagentFailedPayloadSchema,
  SubagentCancelledPayloadSchema,
]);

// ---------------------------------------------------------------------------
// background_agent
// ---------------------------------------------------------------------------

export const BackgroundAgentStartedPayloadSchema = z.object({
  transition: z.literal('started'),
  jobId: z.string(),
  subagentId: z.string(),
  label: z.string(),
  model: z.string(),
});

export const BackgroundAgentCompletedPayloadSchema = z.object({
  transition: z.literal('completed'),
  jobId: z.string(),
  subagentId: z.string(),
  durationMs: z.number().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
});

export const BackgroundAgentFailedPayloadSchema = z.object({
  transition: z.literal('failed'),
  jobId: z.string(),
  subagentId: z.string(),
  durationMs: z.number().nonnegative(),
  errorClass: z.string(),
  errorMessage: z.string(),
});

export const BackgroundAgentJoinedPayloadSchema = z.object({
  transition: z.literal('joined'),
  jobId: z.string(),
  subagentId: z.string(),
  jobStatus: z.enum(['completed', 'failed', 'cancelled']),
});

export const BackgroundAgentDeliveredPayloadSchema = z.object({
  transition: z.literal('delivered'),
  jobId: z.string(),
  subagentId: z.string(),
  jobStatus: z.enum(['completed', 'failed', 'cancelled']),
});

export const BackgroundAgentPayloadSchema = z.discriminatedUnion('transition', [
  BackgroundAgentStartedPayloadSchema,
  BackgroundAgentCompletedPayloadSchema,
  BackgroundAgentFailedPayloadSchema,
  BackgroundAgentCancelledPayloadSchema,
  BackgroundAgentJoinedPayloadSchema,
  BackgroundAgentDeliveredPayloadSchema,
]);

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

export const BudgetPayloadSchema = z.object({
  kind: z.literal('monetary'),
  runningCostUsd: z.number().nonnegative(),
  maxBudgetUsd: z.number().nonnegative(),
  lastTurnCostUsd: z.number().nonnegative(),
});

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

export const AbortOriginSchema = z.enum([
  'user_signal',
  'cascade',
  'timeout',
  'budget',
  'hook_block',
]);

export const AbortPayloadSchema = z.object({
  origin: AbortOriginSchema,
  cascadedTo: z.array(z.string()).readonly(),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// closure
// ---------------------------------------------------------------------------

export const ClosureReasonSchema = z.enum([
  'model_end_turn',
  'truncated',
  'iteration_cap',
  'abort',
  'timeout',
  'budget_exceeded',
  'hook_blocked',
  'max_turns_exceeded',
]);

export const ClosurePayloadSchema = z.object({
  reason: ClosureReasonSchema,
  finalTurnCount: z.number().int().nonnegative(),
  finalCostUsd: z.number().nonnegative(),
  finalTokens: z.object({
    input: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative().optional(),
    cacheRead: z.number().int().nonnegative().optional(),
    cacheCreation: z.number().int().nonnegative().optional(),
  }),
  lastStopReason: z.string().optional(),
  // Actionable recovery hint for an anomalous closure (closure-anomaly
  // guardrail, `session/closure-guidance.ts`). Optional + back-compat: older
  // traces and benign closes simply omit it.
  guidance: z.string().optional(),
});

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

export const ClaimPayloadSchema = z.object({
  source: z.string(),
  assertion: z.string(),
  evidence: z.array(z.string()).readonly(),
  confidence: z.number().min(0).max(1),
  dissent: z.string().optional(),
});

// ---------------------------------------------------------------------------
// queued_user_message
// ---------------------------------------------------------------------------

export const QueuedUserMessagePayloadSchema = z.object({
  jobId: z.string(),
  subagentId: z.string(),
  byteLength: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// peer_message
// ---------------------------------------------------------------------------

export const PeerMessagePayloadSchema = z.object({
  // 'delivered' is a legacy value (pre-#2810); retained for backward-compatible deserialization of historical traces.
  action: z.enum(['sent', 'claimed', 'injected', 'delivered', 'held', 'refused', 'dropped', 'reclaimed']),
  messageId: z.string().optional(),
  peer: z.string(),
  bytes: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// session_sealed
// ---------------------------------------------------------------------------

export const SessionSealedPayloadSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  finalCostUsd: z.number().nonnegative(),
  finalTurnCount: z.number().int().nonnegative(),
  closedAt: z.string().datetime(),
  incomplete: z.boolean().optional(),
  subagentCount: z.number().int().nonnegative().optional(),
  subagentTokens: z
    .object({
      input: z.number().int().nonnegative().optional(),
      output: z.number().int().nonnegative().optional(),
      cacheRead: z.number().int().nonnegative().optional(),
      cacheCreation: z.number().int().nonnegative().optional(),
    })
    .optional(),
  subagentCostUsd: z.number().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Whole-event discriminated unions
// ---------------------------------------------------------------------------

/** Validates what an emission site passes to the writer. The writer
 *  internally swaps the compaction payload for the persisted form. */
export const TraceEventInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool_call'), payload: ToolCallPayloadSchema }),
  z.object({ kind: z.literal('hook_decision'), payload: HookDecisionPayloadSchema }),
  z.object({
    kind: z.literal('subagent_lifecycle'),
    payload: SubagentLifecyclePayloadSchema,
  }),
  z.object({
    kind: z.literal('background_agent'),
    payload: BackgroundAgentPayloadSchema,
  }),
  z.object({ kind: z.literal('budget'), payload: BudgetPayloadSchema }),
  z.object({ kind: z.literal('abort'), payload: AbortPayloadSchema }),
  z.object({ kind: z.literal('compaction'), payload: CompactionPayloadInputSchema }),
  z.object({ kind: z.literal('closure'), payload: ClosurePayloadSchema }),
  z.object({ kind: z.literal('claim'), payload: ClaimPayloadSchema }),
  z.object({ kind: z.literal('browser_event'), payload: BrowserEventPayloadSchema }),
  z.object({ kind: z.literal('queued_user_message'), payload: QueuedUserMessagePayloadSchema }),
  z.object({ kind: z.literal('peer_message'), payload: PeerMessagePayloadSchema }),
  z.object({ kind: z.literal('session_phase'), payload: SessionPhasePayloadSchema }),
]);

/** Validates a persisted trace event (what readers parse from JSONL). */
export const TraceEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('tool_call'),
    payload: ToolCallPayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('hook_decision'),
    payload: HookDecisionPayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('subagent_lifecycle'),
    payload: SubagentLifecyclePayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('background_agent'),
    payload: BackgroundAgentPayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('budget'),
    payload: BudgetPayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('abort'),
    payload: AbortPayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('compaction'),
    payload: CompactionPayloadPersistedSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('closure'),
    payload: ClosurePayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('claim'),
    payload: ClaimPayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('browser_event'),
    payload: BrowserEventPayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('queued_user_message'),
    payload: QueuedUserMessagePayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('peer_message'),
    payload: PeerMessagePayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('session_phase'),
    payload: SessionPhasePayloadSchema,
  }),
  z.object({
    ts: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    kind: z.literal('session_sealed'),
    payload: SessionSealedPayloadSchema,
  }),
]);
