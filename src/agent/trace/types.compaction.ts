/** Compaction trace contracts. Re-exported from ./types for existing consumers. */
export type CompactionTrigger = 'manual' | 'token_threshold' | 'turn_count';

/** Input form — what emission sites construct. Carries the full
 *  pre-compaction slice inline. The writer transforms this into the
 *  persisted form by writing the slice to a sidecar. */
export interface CompactionPayloadInput {
  trigger: CompactionTrigger;
  /** Full-fidelity message slice that compaction is about to discard
   *  from working memory. Typed `unknown[]` to keep the trace module
   *  provider-agnostic; emitters serialize whatever shape they hold. */
  preCompactionMessages: unknown[];
  summary: string;
  keptTailCount: number;
  keepLastNConfig: number;
  messagesBefore: number;
  messagesAfter: number;
  tokensSavedEstimate?: number;
  summarizationTokens?: { input: number; output: number };
  /** UTF-16 code units dropped by the summarizer transcript cap; 0 = no drop.
   *  Absent on older traces. Excludes per-tool excerpt elisions. */
  summarizerInputCharsDropped?: number;
}

/** Reference to a sidecar file holding the full-fidelity pre-compaction
 *  slice. The path is absolute. */
export interface CompactionSidecarRef {
  /** Absolute path to the sidecar JSON file. */
  path: string;
  sizeBytes: number;
  /** SHA-256 hex digest of the sidecar contents, for integrity. */
  sha256: string;
}

/** Persisted form — what ends up on the JSONL line. */
export interface CompactionPayloadPersisted {
  trigger: CompactionTrigger;
  preCompactionMessagesRef: CompactionSidecarRef;
  summary: string;
  keptTailCount: number;
  keepLastNConfig: number;
  messagesBefore: number;
  messagesAfter: number;
  tokensSavedEstimate?: number;
  summarizationTokens?: { input: number; output: number };
  /** UTF-16 code units dropped by the summarizer transcript cap; 0 = no drop.
   *  Absent on older traces. Excludes per-tool excerpt elisions. */
  summarizerInputCharsDropped?: number;
}
