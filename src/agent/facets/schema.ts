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
 * tool_errors_total, durations, world_changes) are computed exactly from the
 * session; SEMANTIC fields (goal_categories, brief_summary, outcome,
 * outcome_source, primary_success) are heuristic and enrichable later — kept
 * honest, never fabricated. `outcome` now uses the shared parseTerminalState()
 * parser from `src/agent/outcomes/terminal-state.ts` (v7, #2777).
 */

import { z } from 'zod';

/**
 * Bump when the facet shape or derivation changes — invalidates caches.
 *
 * v7 (#2777): added `outcome_source`, `tool_errors_total`, and required
 * nullable `yield_tracking.pr_url`; added `'unknown'` to FacetOutcomeSchema;
 * replaced inline TERMINAL_STATE_RE in derive.ts with the shared
 * parseTerminalState() parser; yield_tracking carry-forward on re-derive in
 * store.ts. Public consumers should filter on `facet_version >= 7` and inspect
 * `outcome_source`; headingless sessions now derive `outcome: 'unknown'`, and
 * single-line `**Done** — text` is no longer a terminal-state heading.
 *
 * v8 (#2970): added `compose_partial_nodes`, the number of compose CALLS in
 * which at least one node succeeded with a partial result (soft-deadline
 * wind-down, tool-use cap). Omitted when zero. Also added
 * `incomplete?: boolean` to `ToolEventInputSchema` so the sidecar path
 * carries the signal. On `facet_version >= 8` an absent field means zero.
 */
export const FACET_VERSION = 8;

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
    /**
     * `true` when this tool result is a subagent's partial answer (e.g.
     * soft-deadline wind-down or tool-use cap on a compose node). Written since
     * #2970; absent on older session records.
     */
    incomplete: z.boolean().optional(),
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
    endedAt: z.number().optional(),
    exitReason: z.enum(['sigint', 'sigterm', 'sighup', 'exit-command', 'eof']).optional(),
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
  /**
   * 'unknown': the last assistant message is non-empty but carries no
   * recognizable terminal-state heading. Added in v7 (#2777) — replaces the
   * prior implicit fall-through to 'fully_achieved' for headingless sessions.
   */
  'unknown',
]);
export type FacetOutcome = z.infer<typeof FacetOutcomeSchema>;

/**
 * How the facet's `outcome` field was determined.
 *
 * - `'terminal_state'`: outcome was read from a Done/Blocked/Asking/Interrupted
 *   heading found in the last non-empty assistant message.
 * - `'structural'`: outcome was determined by structural rules — zero turns
 *   (aborted) or empty last assistant message (partially_achieved).
 * - `'none'`: the last assistant message was non-empty but carried no
 *   recognizable terminal-state heading (outcome = 'unknown').
 *
 * Added in v7 (#2777).
 */
export const FacetOutcomeSourceSchema = z.enum(['terminal_state', 'structural', 'none']);
export type FacetOutcomeSource = z.infer<typeof FacetOutcomeSourceSchema>;

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
 *   - `produced_pr`: true when the session produced a PR (detected either
 *     mechanically from `gh pr create` bash output in derive.ts, or by the
 *     async yield probe at teardown); false when none was found; null when
 *     the check could not run (gh unavailable, not a git repo, etc.).
 *     Note: derive.ts only ever sets produced_pr=true (never false); the
 *     yield probe fills in false when no PR is found on the branch.
 *   - `pr_merged`: true when the associated PR's state is MERGED; false when
 *     open or closed-unmerged; null when produced_pr is false or the check
 *     could not run.
 *   - `pr_url`: the GitHub PR URL when `produced_pr` is true and the URL was
 *     found in the `gh pr create` output. Null when not available. Added v7.
 *
 * Derivation: populated by `createFacetSessionEndHook` after session teardown.
 * Pure-derive callers (no I/O) receive null for produced_pr and pr_merged;
 * the hook overwrites the cached facet with real values once the async gh
 * probe completes. When derive.ts detects a `gh pr create` result URL, it
 * sets produced_pr=true and pr_url in the initial derivation.
 */
export const YieldTrackingSchema = z.object({
  /** True when the session was launched by the daemon scheduler. */
  is_scheduled_session: z.boolean(),
  /**
   * True when the session produced a GitHub PR (mechanical or probe-confirmed).
   * Null when the gh probe could not run (no gh CLI, not a git repo, etc.).
   * derive.ts only sets this true when a `gh pr create` URL is detected;
   * the yield probe fills false when no PR is found on the branch.
   */
  produced_pr: z.boolean().nullable(),
  /**
   * True when the associated PR was merged.
   * Null when produced_pr is false or the probe could not run.
   */
  pr_merged: z.boolean().nullable(),
  /**
   * The GitHub PR URL when produced_pr is true and the URL was detected from
   * a `gh pr create` bash result. Null when URL not available.
   * Added v7 (#2777).
   */
  pr_url: z.string().nullable().default(null),
});
export type YieldTracking = z.infer<typeof YieldTrackingSchema>;

/**
 * Per-subagent tool call breakdown (#2461).
 * Populated in the facet when the parent session has a message journal and at
 * least one subagent journal exists. Each entry covers ONE subagent's own
 * tool calls — they are excluded from the parent's `tool_counts` / `tool_errors`.
 */
export const SubagentToolSummarySchema = z.object({
  subagent_id: z.string(),
  tool_calls: z.number().int(),
  tool_errors: z.number().int(),
  tool_counts: z.record(z.string(), z.number()),
  /**
   * GitHub PR URL detected from a `gh pr create` bash result in this subagent's
   * journal. Set only when the subagent itself opened a PR. (#2795 gap 6)
   */
  detected_pr_url: z.string().nullable().optional(),
});
export type SubagentToolSummary = z.infer<typeof SubagentToolSummarySchema>;

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
    /**
     * Total tool errors across the parent session AND all subagents.
     * = tool_errors + sum(subagent_breakdown[].tool_errors).
     * Added v7 (#2777).
     */
    tool_errors_total: z.number().int(),
    tool_error_categories: z.record(z.string(), z.number()),
    friction_counts: z.record(z.string(), z.number()),
    friction_detail: z.string(),
    /**
     * Number of compose CALLS in which at least one node succeeded with a
     * partial result: soft-deadline wind-down, tool-use-iteration cap, or
     * another incomplete stop reason (#2970). Such calls stay `isError: false`.
     * It counts calls, not nodes; a per-node count is a follow-up. Added in v8
     * and omitted when zero, so on `facet_version >= 8` absence means zero,
     * while on older facets it means "not measured". Optional so old cached
     * facets still validate.
     */
    compose_partial_nodes: z.number().int().optional(),

    // outcome / world changes
    outcome: FacetOutcomeSchema,
    /**
     * How the `outcome` field was determined.
     *
     * - `'terminal_state'`: from a Done/Blocked/Asking/Interrupted heading in
     *   the last non-empty assistant message.
     * - `'structural'`: from structural rules — zero turns (aborted) or empty
     *   last assistant message (partially_achieved).
     * - `'none'`: non-empty last assistant with no recognizable heading
     *   (outcome = 'unknown').
     *
     * Added v7 (#2777).
     */
    outcome_source: FacetOutcomeSourceSchema,
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

    // subagent tool-call breakdown (#2461): excluded from parent tool_counts.
    // Optional: absent when the journal is unavailable or there are no subagents.
    subagent_breakdown: z.array(SubagentToolSummarySchema).optional(),
  })
  .passthrough();

export type SessionFacet = z.infer<typeof SessionFacetSchema>;
export type SubagentInvocation = z.infer<typeof SubagentInvocationSchema>;
export type WorldChanges = z.infer<typeof WorldChangesSchema>;
