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

export const VoteSchema = z.object({
  lf: z.string(),
  vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  strength: z.enum(['strong', 'weak']),
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
   * First prompt text (normalized for cross_session_reask Jaccard comparison).
   * Stored at teardown; absent on records written before M2 or when unavailable.
   */
  first_prompt: z.string().optional(),
  /**
   * Effective cwd at session start. Stored alongside first_prompt so the
   * cross_session_reask LF can filter to the same directory.
   */
  first_cwd: z.string().optional(),
});

export type VerifiedOutcome = z.infer<typeof VerifiedOutcomeSchema>;

// ---------------------------------------------------------------------------
// Label type alias for convenience
// ---------------------------------------------------------------------------

export type OutcomeLabel = VerifiedOutcome['label'];
export type SelfReport = VerifiedOutcome['self_report'];
