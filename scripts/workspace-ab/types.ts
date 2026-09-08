/**
 * Shared types for workspace A/B measurement and analysis.
 *
 * Extracted from `scripts/measure-read-dedup.ts` so the analyzer logic can be
 * tested independently of the CLI entry point and trace-resolution I/O.
 *
 * @module scripts/workspace-ab/types
 */

// ─── Parsed trace data ──────────────────────────────────────────────────────

/** A single `tool_call.started` event parsed from a witness trace. */
export interface ToolCallStarted {
  name: string;
  argsFingerprint: string;
  /** SHA-256 of the normalized resource (file path without offset/limit).
   *  Absent for non-resource tools and pre-upgrade traces. */
  resourceFingerprint?: string;
  /** `'root'` for the top-level session; subagent id otherwise. */
  subagentId: string;
  toolUseId: string;
  seq: number;
  ts: string;
}

// ─── Analysis output ────────────────────────────────────────────────────────

export interface FingerprintGroup {
  fingerprint: string;
  toolName: string;
  agents: Set<string>;
  totalCalls: number;
  callDetails: Array<{ subagentId: string; seq: number; ts: string }>;
}

/** A single hot-fingerprint entry in the report (Set serialized to string[]). */
export interface HotFingerprint {
  fingerprint: string;
  toolName: string;
  agentCount: number;
  totalCalls: number;
  agents: string[];
}

export interface DedupReport {
  tracePath: string;
  toolFilter: string;
  totalCalls: number;
  uniqueFingerprints: number;
  /** Calls where a *different* agent already read the same tool+args. */
  crossAgentDuplicates: number;
  /** Same agent repeating the same tool+args (retries / loops). */
  selfDuplicates: number;
  /** crossAgentDuplicates / totalCalls -- the headline A/B metric. */
  crossAgentDedupRatio: number;
  /** Fraction of file-level reads duplicated across agents (via
   *  `resourceFingerprint`). `null` when no resource fingerprints are
   *  available in the trace. */
  crossAgentFileOverlapRatio: number | null;
  distinctAgents: number;
  /** Fingerprints read by >1 agent, sorted by total calls descending. */
  hotFingerprints: HotFingerprint[];
  skippedNoFingerprint: number;
  totalToolCallStarted: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ValidationFailure =
  | { rule: 'no-subagents'; message: string }
  | { rule: 'too-few-reading-agents'; message: string; agentCount: number }
  | { rule: 'missing-fingerprints'; message: string; ratio: number }
  | { rule: 'no-closure'; message: string }
  | { rule: 'high-child-failure-rate'; message: string; rate: number };

export interface ValidationResult {
  valid: boolean;
  failures: ValidationFailure[];
}
