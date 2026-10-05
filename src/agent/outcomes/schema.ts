/**
 * Zod schema for VerifiedOutcome — the session outcome label built from
 * observed facts. Design: docs/proposals/verified-outcome.md.
 *
 * Storage (M2+): ~/.afk/agent-framework/outcomes/<sessionId>.json
 * Runtime wiring is NOT done in M0; this module is pure data definition.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Vote record — one labeling-function's contribution
// ---------------------------------------------------------------------------

/**
 * Severity tier for a vote. Describes the weight of a negative signal.
 *
 * Tier assignments (from combiner v2 spec):
 *   critical — explicit_feedback bad, commit_survival revert
 *   major    — closure abort, error_tail, verification fail, cross_session_reask <30min
 *   minor    — cross_session_reask 30min-24h, in_session_correction, budget_cap, fix_of_fix
 *
 * When `severity` is absent (pre-v2 records) the combiner back-maps:
 *   strong → major, weak → minor
 */
export const VoteSeveritySchema = z.enum(['critical', 'major', 'minor']);
export type VoteSeverity = z.infer<typeof VoteSeveritySchema>;

export const VoteSchema = z.object({
  lf: z.string(),
  vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  strength: z.enum(['strong', 'weak']),
  /** Optional — absent in pre-v2 records; combiner back-maps via strength. */
  severity: VoteSeveritySchema.optional(),
  evidence: z.string(),
  observed_at: z.string(),
});

export type Vote = z.infer<typeof VoteSchema>;

// ---------------------------------------------------------------------------
// History entry — immutable log of label changes over time
// ---------------------------------------------------------------------------

export const HistoryEntrySchema = z.object({
  at: z.string(),
  label: z.string(),
  reason: z.string(),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// ---------------------------------------------------------------------------
// Artifacts — recovered from result previews
// ---------------------------------------------------------------------------

export const ArtifactsSchema = z.object({
  commits: z.array(z.string()),
  prs: z.array(z.string()),
  repo: z.string().nullable(),
});

export type Artifacts = z.infer<typeof ArtifactsSchema>;

// ---------------------------------------------------------------------------
// VerifiedOutcome — the top-level label record
// ---------------------------------------------------------------------------

export const VerifiedOutcomeSchema = z.object({
  schema_version: z.literal(1),
  session_id: z.string(),
  label: z.enum(['succeeded', 'failed', 'interrupted', 'blocked', 'unknown']),
  confidence: z.number().min(0).max(1),
  state: z.enum(['provisional', 'settled']),
  settles_after: z.string().nullable(),
  session_kind: z.enum(['mutating', 'text']),
  self_report: z.enum(['done', 'blocked', 'asking', 'interrupted', 'none']),
  artifacts: ArtifactsSchema,
  votes: z.array(VoteSchema),
  history: z.array(HistoryEntrySchema),
  /**
   * Prompt fingerprint: sorted, deduplicated token array (max 64 tokens) used
   * for cross_session_reask Jaccard comparison. Raw prompt text is intentionally
   * never stored here (issue #2449). Legacy `first_prompt` keys from records
   * written before this change are stripped on the next read-modify-write,
   * because this schema uses a plain z.object (not .passthrough()) which strips
   * unknown keys on parse.
   */
  first_prompt_tokens: z.array(z.string()).max(64).optional(),
  /**
   * Effective cwd at session start. Stored alongside first_prompt_tokens so the
   * cross_session_reask LF can filter to the same directory.
   */
  first_cwd: z.string().optional(),
  /**
   * How the label was established. 'proven' = strong positive/negative evidence;
   * 'no_bad_signals' = good-by-default (no negatives, past settle window).
   * Absent on pre-v2 records or when label is unknown/blocked.
   * Used by KPI layer to separate proven-good from presumed-good counts.
   */
  basis: z.enum(['proven', 'no_bad_signals']).optional(),
});

export type VerifiedOutcome = z.infer<typeof VerifiedOutcomeSchema>;

// ---------------------------------------------------------------------------
// Label type alias for convenience
// ---------------------------------------------------------------------------

export type OutcomeLabel = VerifiedOutcome['label'];
export type SelfReport = VerifiedOutcome['self_report'];
