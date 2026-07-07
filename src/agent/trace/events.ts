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

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

export const ToolCallStartedPayloadSchema = z.object({
  phase: z.literal('started'),
  toolUseId: z.string(),
  name: z.string(),
  inputBytes: z.number().int().nonnegative(),
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
  /** Set when the event was produced by the repeat-loop circuit breaker. */
  circuitBreaker: z.boolean().optional(),
  /** Coarse failure classification when `isError` is true. Absent otherwise. */
  failureClass: ToolFailureClassSchema.optional(),
  subagentId: z.string().optional(),
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
  injectedContextBytes: z.number().int().nonnegative().optional(),
  /** Set only by the AFK high-risk approval gate. Wall-clock ms from gate entry to decision. */
  durationMs: z.number().nonnegative().optional(),
  /** Set only by the AFK high-risk approval gate. Fine-grained approval outcome. */
  approvalOutcome: z.enum(['approved', 'denied', 'unrecognised', 'timeout', 'decline', 'cancel']).optional(),
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
});

export const SubagentCancelledPayloadSchema = z.object({
  transition: z.literal('cancelled'),
  subagentId: z.string(),
  source: z.enum(['cascade', 'explicit']),
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

export const BackgroundAgentCancelledPayloadSchema = z.object({
  transition: z.literal('cancelled'),
  jobId: z.string(),
  subagentId: z.string(),
  source: z.enum(['explicit', 'cascade']),
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
// compaction — two schemas (input vs persisted)
// ---------------------------------------------------------------------------

export const CompactionTriggerSchema = z.enum([
  'manual',
  'token_threshold',
  'turn_count',
]);

export const CompactionSidecarRefSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Input form — accepts the inline message slice. The writer validates
 *  with this schema, then transforms to the persisted form. */
export const CompactionPayloadInputSchema = z.object({
  trigger: CompactionTriggerSchema,
  preCompactionMessages: z.array(z.unknown()),
  summary: z.string(),
  keptTailCount: z.number().int().nonnegative(),
  keepLastNConfig: z.number().int().nonnegative(),
  messagesBefore: z.number().int().nonnegative(),
  messagesAfter: z.number().int().nonnegative(),
  tokensSavedEstimate: z.number().nonnegative().optional(),
  summarizationTokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
});

/** Persisted form — what readers parse. */
export const CompactionPayloadPersistedSchema = z.object({
  trigger: CompactionTriggerSchema,
  preCompactionMessagesRef: CompactionSidecarRefSchema,
  summary: z.string(),
  keptTailCount: z.number().int().nonnegative(),
  keepLastNConfig: z.number().int().nonnegative(),
  messagesBefore: z.number().int().nonnegative(),
  messagesAfter: z.number().int().nonnegative(),
  tokensSavedEstimate: z.number().nonnegative().optional(),
  summarizationTokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
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
// browser_event
// ---------------------------------------------------------------------------

export const BrowserEventToolSchema = z.enum([
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_screenshot',
  'browser_extract',
  'browser_close',
]);

export const BrowserActActionSchema = z.enum([
  'click',
  'fill',
  'press',
  'select',
  'hover',
  'scroll_to',
  'wait_for',
]);

export const BrowserEventTargetSchema = z.object({
  kind: z.enum(['semantic', 'element_id', 'selector']),
  text: z.string().max(80).optional(),
  role: z.string().optional(),
  elementId: z.string().optional(),
  // 8 hex chars per BrowserEventTarget.selectorHash contract.
  selectorHash: z.string().regex(/^[0-9a-f]{8}$/).optional(),
});

export const BrowserEventPayloadSchema = z.object({
  tool: BrowserEventToolSchema,
  action: BrowserActActionSchema.optional(),
  toolUseId: z.string(),
  target: BrowserEventTargetSchema.optional(),
  urlBefore: z.string().nullable(),
  urlAfter: z.string().nullable(),
  status: z.enum(['ok', 'error', 'ambiguous_target', 'blocked_by_policy']),
  screenshotPath: z.string().optional(),
  observationSummary: z.string().max(500).optional(),
  error: z
    .object({
      reason: z.string(),
      recoverable: z.boolean(),
    })
    .optional(),
  durationMs: z.number().nonnegative(),
});

// ---------------------------------------------------------------------------
// session_phase
// ---------------------------------------------------------------------------

export const SessionPhaseNameSchema = z.enum([
  'bootstrap_start',
  'bootstrap_done',
  'session_init_start',
  'session_init_done',
  'mcp_connect_start',
  'mcp_connect_done',
  'mcp_server_start',
  'mcp_server_done',
  'loop_start',
  'loop_end',
  'model_ttfb',
  'rate_limit',
]);

export const SessionPhasePayloadSchema = z.object({
  phase: SessionPhaseNameSchema,
  durationMs: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  // Model provenance — see SessionPhasePayload JSDoc in types.ts. `model` is
  // the operator-typed alias, `resolvedModel` the wire id. Both optional:
  // present on session_init_start; resolvedModel also on model_ttfb.
  model: z.string().optional(),
  resolvedModel: z.string().optional(),
  // Session-identity attribution — see SessionPhasePayload JSDoc in types.ts.
  // `origin` = user-facing surface (cli/telegram/daemon); `actor` = main vs
  // subagent. Both set on session_init_start. Orthogonal to the JSONL
  // `surface: 'afk'|'plugin'` provenance tag.
  origin: z.enum(['cli', 'telegram', 'daemon', 'unknown']).optional(),
  actor: z.enum(['main', 'subagent']).optional(),
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
