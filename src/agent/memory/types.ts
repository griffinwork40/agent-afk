/**
 * Types for the cross-session memory system.
 *
 * Three layers: hot memory (system prompt injection), session archive
 * (SQLite + FTS5), and procedural memory (markdown files).
 *
 * @module agent/memory/types
 */

export type FactCategory = 'preference' | 'convention' | 'decision' | 'learning';
export type SessionOutcome = 'completed' | 'failed' | 'abandoned';
export type MemoryUpdateAction = 'set' | 'supersede' | 'remove';
export type MemoryUpdateTarget = 'hot' | 'fact';

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
}

export interface NewFact {
  session_id?: string;
  category: FactCategory;
  content: string;
  source_surface: string;
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
}

export interface NewSession {
  session_id: string;
  surface: string;
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
}

export interface WALEntry {
  type: 'fact' | 'session_start' | 'session_end' | 'supersede';
  timestamp: string;
  data: Record<string, unknown>;
}
