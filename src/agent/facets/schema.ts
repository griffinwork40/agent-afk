/**
 * SessionFacet — the canonical, consumer-facing projection of an AFK session.
 *
 * A facet is a structured summary derived from a persisted `StoredSession`
 * (~/.afk/state/sessions/<id>.json). Downstream consumers (evals, debug views,
 * improvement loops) read facets instead of raw session
 * internals, so the session-store shape can evolve without breaking them.
 *
 * Two schemas live here:
 *   - StoredSessionInputSchema — the SUBSET of the persisted session this
 *     module reads. Defined locally (not imported from src/cli/session-store)
 *     to honour the layering invariant: src/agent/ must never import src/cli/.
 *     `.passthrough()` keeps unknown fields rather than stripping them.
 *   - SessionFacetSchema — the derived, validated output object.
 *
 * Field tiers (see derive.ts): MECHANICAL fields (tool_counts, tool_errors,
 * durations, world_changes) are computed exactly from the session; SEMANTIC
 * fields (goal_categories, brief_summary, outcome, primary_success) are
 * heuristic in v1 and enrichable later by an LLM digest pass — kept honest,
 * never fabricated.
 */

import { z } from 'zod';

/** Bump when the facet shape or derivation changes — invalidates caches. */
export const FACET_VERSION = 5;

// ---------------------------------------------------------------------------
// Input: the subset of StoredSession the deriver reads (local, layering-safe)
// ---------------------------------------------------------------------------

export const ToolEventInputSchema = z
  .object({
    toolName: z.string(),
    toolUseId: z.string().optional(),
    input: z.string().optional(),
    /** Raw JSON-serialized tool input — populated by the CLI session writer for exact field extraction. */
    inputRaw: z.string().optional(),
    result: z.string().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export const TurnInputSchema = z
  .object({
    user: z.string().default(''),
    assistant: z.string().default(''),
    timestamp: z.number().optional(),
    toolEvents: z.array(ToolEventInputSchema).optional(),
  })
  .passthrough();

export const StoredSessionInputSchema = z
  .object({
    sessionId: z.string().optional(),
    name: z.string().optional(),
    source: z.enum(['cli', 'telegram', 'web', 'daemon']).optional(),
    telegramChatId: z.number().optional(),
    model: z.string(),
    startedAt: z.number(),
    savedAt: z.number(),
    totalTurns: z.number(),
    totalCostUsd: z.number().optional(),
    totalTokens: z.number().optional(),
    totalDurationMs: z.number().optional(),
    turns: z.array(TurnInputSchema).default([]),
    forkedFrom: z.string().optional(),
    forkedAt: z.number().optional(),
  })
  .passthrough();

export type StoredSessionInput = z.infer<typeof StoredSessionInputSchema>;
export type ToolEventInput = z.infer<typeof ToolEventInputSchema>;

// ---------------------------------------------------------------------------
// Output: the derived SessionFacet
// ---------------------------------------------------------------------------

export const FacetOutcomeSchema = z.enum([
  'fully_achieved',
  'partially_achieved',
  'not_achieved',
  'aborted',
]);
export type FacetOutcome = z.infer<typeof FacetOutcomeSchema>;

/**
 * Whether the transcripts of any subagents this session spawned are separately
 * persisted. In AFK they are NOT (forked subagent sessions never call
 * saveSession), so facets reconstruct subagent *invocations* from the parent's
 * tool events and stamp this 'not_persisted'. See derive.ts.
 */
export const SubagentPersistenceSchema = z.enum([
  'not_persisted',
  'persisted',
  'unknown',
]);

export const SubagentInvocationSchema = z.object({
  /** Dispatch tool: 'agent' | 'compose' | 'skill'. */
  tool: z.string(),
  /** Best-effort label: id_prefix (agent), skill name (skill), or 'compose'. */
  label: z.string().optional(),
});

export const WorldChangesSchema = z.object({
  files_written: z.number().int(),
  files_edited: z.number().int(),
  bash_commands: z.number().int(),
  commits: z.number().int(),
  /** True if the session performed any state-mutating action. */
  mutated: z.boolean(),
});

/**
 * Token and cost breakdown for a session (populated when session.totalCostUsd is present).
 *
 * Contract: cost_usd is always present when token_breakdown is included.
 * input/output/cache_read/cache_creation are omitted rather than zero-filled
 * because StoredSession only carries totalTokens (a scalar sum); per-direction
 * counts are not available from the persisted session shape and zero-filling
 * would imply they are real measurements.
 */
export const TokenBreakdownSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_creation: z.number().optional(),
  cost_usd: z.number(),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>;

/**
 * Parallel dispatch ratio — measures how often the model chose to issue
 * multiple tool calls in a single assistant turn ("parallel dispatch") vs.
 * issuing them one at a time.
 *
 * Derivation: the session sidecar groups all tool calls emitted in one
 * assistant turn under a single TurnRecord.toolEvents array. A turn is
 * "parallel" when it contains more than one deduplicated tool call (i.e.
 * the model returned multiple tool_use blocks at once). The ratio is:
 *
 *   parallel_tool_calls / total_tool_calls
 *
 * where `parallel_tool_calls` is the count of tool calls that belong to turns
 * with >1 call, and `total_tool_calls` is the total deduplicated call count.
 *
 * `ratio` is null when there are no tool calls (avoids 0/0).
 *
 * This metric enables before/after comparison of parallel-first prompt changes
 * (e.g. #1676): a higher ratio means the model more often batched tool calls.
 * Historical sidecars can be retroactively scored because the per-turn grouping
 * is already captured in the sidecar format.
 */
export const ParallelDispatchStatsSchema = z.object({
  /** Total deduplicated tool calls across all turns. */
  total_tool_calls: z.number().int(),
  /** Tool calls that belong to turns with more than one call (parallel turns). */
  parallel_tool_calls: z.number().int(),
  /** Number of turns that had more than one tool call (parallel turns). */
  parallel_turns: z.number().int(),
  /** Total turns that had at least one tool call. */
  tool_turns: z.number().int(),
  /**
   * Fraction of tool calls that occurred in a parallel turn.
   * Null when total_tool_calls === 0 (no tool calls to measure).
   */
  ratio: z.number().nullable(),
});
export type ParallelDispatchStats = z.infer<typeof ParallelDispatchStatsSchema>;

/**
 * Session yield tracking — records whether a top-level implementation session
 * produced a GitHub PR and whether that PR was subsequently merged.
 *
 * Fields:
 *   - `is_scheduled_session`: true when the session was launched by the daemon
 *     (source === 'daemon'). Scheduled sessions are excluded from the yield
 *     denominator; only human-initiated implementation sessions count.
 *   - `produced_pr`: true when the session's working branch had an associated
 *     PR at teardown time; false when none was found; null when the check could
 *     not run (gh unavailable, not a git repo, etc.).
 *   - `pr_merged`: true when the associated PR's state is MERGED; false when
 *     open or closed-unmerged; null when produced_pr is false or the check
 *     could not run.
 *
 * Derivation: populated by `createFacetSessionEndHook` after session teardown.
 * Pure-derive callers (no I/O) receive null for produced_pr and pr_merged;
 * the hook overwrites the cached facet with real values once the async gh
 * probe completes.
 */
export const YieldTrackingSchema = z.object({
  /** True when the session was launched by the daemon scheduler. */
  is_scheduled_session: z.boolean(),
  /**
   * True when the session's branch had a GitHub PR at teardown.
   * Null when the gh probe could not run (no gh CLI, not a git repo, etc.).
   */
  produced_pr: z.boolean().nullable(),
  /**
   * True when the associated PR was merged.
   * Null when produced_pr is false or the probe could not run.
   */
  pr_merged: z.boolean().nullable(),
});
export type YieldTracking = z.infer<typeof YieldTrackingSchema>;

export const SessionFacetSchema = z
  .object({
    // provenance & identity
    facet_version: z.number().int(),
    session_id: z.string(),
    source: z.enum(['cli', 'telegram', 'web', 'daemon', 'unknown']),
    model: z.string(),
    derived_at: z.string(),
    derived_from: z.literal('afk-session'),
    source_session_path: z.string(),
    source_session_mtime_ms: z.number(),
    subagent_persistence: SubagentPersistenceSchema,

    // timestamps
    start_time: z.string(),
    end_time: z.string(),
    duration_minutes: z.number(),

    // goal / ask
    underlying_goal: z.string(),
    first_prompt: z.string(),
    goal_categories: z.record(z.string(), z.number()),
    session_type: z.string(),
    brief_summary: z.string(),

    // activity: tools / commands / skills / subagents
    total_turns: z.number().int(),
    user_message_count: z.number().int(),
    assistant_message_count: z.number().int(),
    tool_counts: z.record(z.string(), z.number()),
    commands: z.array(z.string()),
    skills: z.array(z.string()),
    subagents: z.array(SubagentInvocationSchema),

    // errors / friction
    tool_errors: z.number().int(),
    tool_error_categories: z.record(z.string(), z.number()),
    friction_counts: z.record(z.string(), z.number()),
    friction_detail: z.string(),

    // outcome / world changes
    outcome: FacetOutcomeSchema,
    primary_success: z.string(),
    world_changes: WorldChangesSchema,

    // token / cost breakdown (optional; populated when session.totalCostUsd present)
    token_breakdown: TokenBreakdownSchema.optional(),

    // parallel dispatch ratio — measures how often the model batched tool calls (#2015)
    parallel_dispatch: ParallelDispatchStatsSchema,

    // session yield tracking (#2016)
    yield_tracking: YieldTrackingSchema,

    // decisions / evidence (v1-thin; semantic-enrichable)
    decisions: z.array(z.string()),
    evidence_pointers: z.array(z.string()),
  })
  .passthrough();

export type SessionFacet = z.infer<typeof SessionFacetSchema>;
export type SubagentInvocation = z.infer<typeof SubagentInvocationSchema>;
export type WorldChanges = z.infer<typeof WorldChangesSchema>;
