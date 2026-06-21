/**
 * Types for the cross-session memory system.
 *
 * Three layers: hot memory (system prompt injection), session archive
 * (SQLite + FTS5), and procedural memory (markdown files).
 *
 * @module agent/memory/types
 */

import type { TraceActor } from '../session/session-identity.js';

export type FactCategory = 'preference' | 'convention' | 'decision' | 'learning';
export type SessionOutcome = 'completed' | 'failed' | 'abandoned';
export type MemoryUpdateAction = 'set' | 'supersede' | 'remove';
export type MemoryUpdateTarget = 'hot' | 'fact';

/**
 * Recall-time provenance verdict for a fact, computed by the evidence gate
 * (see `./memory-evidence.ts`). Only meaningful when the gate is enabled
 * (AFK_MEMORY_EVIDENCE_GATE=1); otherwise the field is omitted from results.
 *   - 'verified'        — a codebase-fact category carrying a citation.
 *   - 'unverified'      — a codebase-fact category with no citation; recalled
 *                         content is prefixed `[unverified]`.
 *   - 'not-applicable'  — a preference/reflection category (never gated).
 */
export type FactVerification = 'verified' | 'unverified' | 'not-applicable';

export interface Fact {
  id: number;
  session_id: string | null;
  created_at: string;
  category: FactCategory;
  content: string;
  source_surface: string;
  superseded_by: number | null;
  confidence: number;
  access_count: number;
  last_accessed: string | null;
  /**
   * Provenance citation backing a codebase fact (file:line, commit SHA,
   * trace-event id, …). NULL on rows written before schema v4 and on any
   * uncited write. Surfaced + verdict-classified at recall only when the
   * evidence gate is enabled.
   */
  evidence: string | null;
}

export interface NewFact {
  session_id?: string;
  category: FactCategory;
  content: string;
  source_surface: string;
  /** Optional provenance citation; see {@link Fact.evidence}. */
  evidence?: string | null;
}

export interface SessionRecord {
  session_id: string;
  surface: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  tools_used: string;
  outcome: SessionOutcome | null;
  token_count: number | null;
  cost_usd: number | null;
  /** Execution role ('main' | 'subagent'); NULL on rows written before v3. */
  actor?: TraceActor | null;
}

export interface NewSession {
  session_id: string;
  surface: string;
  /**
   * Execution role of the owning session: 'main' | 'subagent'. Optional and
   * additive — absent on legacy callers (and read back as NULL). Subagent
   * sessions are suppressed upstream by the SessionEnd hook's parent-session
   * guard, so in practice this is 'main' whenever set today; the column exists
   * for schema uniformity with the other session-identity telemetry surfaces.
   */
  actor?: TraceActor;
}

export interface Procedure {
  name: string;
  content: string;
  created: string;
  source_session: string | null;
  access_count: number;
}

export interface SearchOpts {
  category?: FactCategory;
  since?: string;
  limit?: number;
}

export interface MemorySearchResult {
  type: 'fact' | 'procedure';
  content: string;
  category?: FactCategory;
  created_at: string;
  source_session?: string | null;
  confidence: number;
  /**
   * Provenance citation, populated from {@link Fact.evidence}. Surfaced to the
   * agent only when the evidence gate is enabled; omitted otherwise so
   * gate-off recall output is byte-identical to legacy behavior.
   */
  evidence?: string | null;
  /**
   * Recall-time provenance verdict. Present only when the evidence gate is
   * enabled; see {@link FactVerification}.
   */
  verification?: FactVerification;
}

export interface WALEntry {
  type: 'fact' | 'session_start' | 'session_end' | 'supersede';
  timestamp: string;
  data: Record<string, unknown>;
}
