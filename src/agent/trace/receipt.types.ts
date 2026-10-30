/**
 * Run-receipt data shapes (split from receipt.ts for the file-size ceiling).
 *
 * v3 adds `outcomes` (OutcomesV1, computed once per root session by
 * outcomes/session-outcomes.ts). Consumers (e.g. the Q ledger) key on
 * `sessionId` and map `outcomes` per OutcomesV1Schema.
 *
 * @module agent/trace/receipt.types
 */

import type { CostTokens, SessionCostSource } from './cost.js';
import type { JournalSummary } from './receipt.journal.js';
import type { OutcomesV1 } from '../outcomes/outcomes-v1.schema.js';
import type { ClosureReason, ToolFailureClass, TraceEventKind } from './types.js';

export const RECEIPT_SCHEMA_VERSION = 3 as const;

/** A single failed tool call, summarized from trace metadata (no raw output). */
export interface ReceiptToolFailure {
  toolUseId: string;
  name: string;
  failureClass?: ToolFailureClass;
  durationMs: number;
  ts: string;
  truncated: boolean;
  /** True when `failureClass` is a benign outcome that does not warrant review. */
  exempt: boolean;
  subagentId?: string;
}

/** The machine-readable run receipt. Written to `<receipts>/<label>.json`. */
export interface RunReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  generatedAt: string;
  /** Witness-trace directory name — the stable correlation key for this run. */
  witnessLabel: string;
  /** Absolute path to the sealed `trace.jsonl` this receipt summarizes. */
  tracePath: string;
  /** Logical session id, when the session exposed one (may be absent). */
  sessionId?: string;
  /** SessionEnd reason that triggered this receipt ('close' | 'reset' | 'error'). */
  endReason?: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  closureReason?: ClosureReason;
  lastStopReason?: string;
  guidance?: string;
  /** True when the trace was sealed by the synchronous process-exit backstop. */
  incomplete: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  toolCalls: {
    total: number;
    succeeded: number;
    errored: number;
    /** `errored` minus the expected-refusal (exempt) classes. */
    erroredNotable: number;
    /**
     * Count of tool calls a gate denylisted: `permission-denied` (allowlist /
     * `canUseTool` deny) + `hook-block` (PreToolUse hook) + `policy-refusal`.
     * A subset of `errored`; per-class detail is in `byFailureClass`. Divide by
     * `total` for the refusal rate. Surfaces denials that `erroredNotable`
     * deliberately excludes — the per-session "how often was a call denied" tally.
     */
    refused: number;
    circuitBreakerHits: number;
    byTool: Record<string, { total: number; errored: number }>;
    byFailureClass: Record<string, number>;
  };
  events: {
    total: number;
    byKind: Partial<Record<TraceEventKind, number>>;
  };
  subagents: {
    started: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  // Contract (#3879): `finalCostUsd` and `tokens` are ROOT-scoped and kept
  // for back-compat: `finalCostUsd` is the seal's root cost (last lifecycle
  // cycle) and `tokens` is the last closure's (normally the root's). Whole-
  // session spend including every subagent is `totalCostUsd` / `totalTokens`,
  // computed by `computeSessionCost` in `./cost.ts`.
  cost: {
    finalCostUsd?: number;
    turnCount?: number;
    tokens?: CostTokens;
    rootCostUsd?: number;
    subagentCostUsd?: number;
    totalCostUsd?: number;
    totalTokens?: CostTokens;
    costSource?: SessionCostSource;
  };
  failures: ReceiptToolFailure[];
  humanReviewRequired: boolean;
  humanReviewReasons: string[];
  limitations: string[];
  /** Journal-derived summary (v2). Absent when the journal is missing or disabled. */
  journalSummary?: JournalSummary;
  /** World changes (v3, OutcomesV1). Absent when no sessionId; null when computation failed. */
  outcomes?: OutcomesV1 | null;
}

/** Inputs to {@link generateReceipt} that are not derivable from the events. */
export interface ReceiptMeta {
  tracePath: string;
  witnessLabel: string;
  sessionId?: string;
  endReason?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Journal-derived summary; threaded in from {@link writeRunReceipt}. */
  journalSummary?: JournalSummary;
  /** Session outcomes; threaded in from {@link writeRunReceipt}. */
  outcomes?: OutcomesV1 | null;
}
