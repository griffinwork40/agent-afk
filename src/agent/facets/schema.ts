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
export const FACET_VERSION = 1;

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
    source: z.enum(['cli', 'telegram']).optional(),
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

export const SessionFacetSchema = z
  .object({
    // provenance & identity
    facet_version: z.number().int(),
    session_id: z.string(),
    source: z.enum(['cli', 'telegram', 'unknown']),
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

    // decisions / evidence (v1-thin; semantic-enrichable)
    decisions: z.array(z.string()),
    evidence_pointers: z.array(z.string()),
  })
  .passthrough();

export type SessionFacet = z.infer<typeof SessionFacetSchema>;
export type SubagentInvocation = z.infer<typeof SubagentInvocationSchema>;
export type WorldChanges = z.infer<typeof WorldChangesSchema>;
