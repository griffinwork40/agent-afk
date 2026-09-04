/**
 * Wave manifest schema — types for the interrupted-session recovery system.
 *
 * A "wave" is a group of ≥2 concurrent subagent dispatches from a single parent
 * turn. The manifest persists dispatch state so a later session can offer to
 * resume unfinished work after a crash, kill, or 429 abort.
 *
 * @module agent/manifest/types
 */

/** Status of one dispatch unit within a wave. */
export type WaveUnitStatus =
  | 'pending'   // created in manifest before fork
  | 'running'   // forkSubagent returned a handle
  | 'done'      // handle settled with success
  | 'failed'    // handle settled with error
  | 'skipped';  // DAG failFast: upstream failed, this node never started

/** Digest of a subagent's prompt. Sufficient to re-dispatch without the original CW. */
export interface PromptDigest {
  /** SHA-256 hex of the full prompt text, for identity/dedup. */
  sha256: string;
  /** First 512 chars of prompt, for operator display and lightweight re-dispatch. */
  head: string;
  /** Total byte length of the original prompt. */
  byteLen: number;
}

/** One dispatch unit inside a wave. */
export interface WaveUnit {
  /** Matches the subagentId assigned by SubagentManager (e.g. "subagent-1748xxxxxx-3"). */
  id: string;
  /** Execution status. Written as 'pending' at manifest creation; updated on settlement. */
  status: WaveUnitStatus;
  promptDigest: PromptDigest;
  /** Effective cwd at fork time. Needed for worktree re-creation check on resume. */
  cwd: string | undefined;
  /** Model string (post-coercion). */
  model: string;
  /** ISO timestamp when status transitioned to 'running'. */
  startedAt: string | undefined;
  /** ISO timestamp when status transitioned to 'done' | 'failed' | 'skipped'. */
  settledAt: string | undefined;
  /** Error message on 'failed', truncated to 500 chars. */
  errorMessage: string | undefined;
  /**
   * For DAG (compose) nodes: upstream dependency node IDs. Needed so a partial
   * resume can re-execute only nodes whose inputs are satisfied.
   */
  upstreamIds: string[];
  /** For worktrees: the .afk-worktrees/ path this unit's cwd sits inside, if any. */
  worktreePath: string | undefined;
}

/** One wave — a group of ≥2 concurrent dispatches from a single parent turn. */
export interface WaveManifest {
  /** Manifest format version. Increment when shape changes. */
  version: 1;
  /** Random UUID assigned at manifest creation. Stable across status updates. */
  waveId: string;
  /** Parent session id (the session that dispatched this wave). */
  parentSessionId: string;
  /** Trace label (witness dir name) of the parent session. */
  traceLabel: string | null;
  /** ISO timestamp when the manifest was first written. */
  createdAt: string;
  /** ISO timestamp of last write (updated on every unit status change). */
  updatedAt: string;
  /** ISO timestamp after which this manifest should be ignored. */
  expiresAt: string;
  /**
   * ISO timestamp when the manifest was first surfaced as a resumption offer.
   * Once set, the reconciler skips this manifest — the operator has been informed
   * and further surfaces would be spam. Written by the caller (not the reconciler)
   * AFTER successful delivery so a send failure leaves the manifest unsuppressed.
   */
  offeredAt?: string;
  /**
   * Source coordinator:
   *   'agent-tool'   — SubagentExecutor parallel wave
   *   'compose-dag'  — ComposeExecutor DAG
   *   'skill-fanout' — SkillExecutor fork fan-out
   */
  source: 'agent-tool' | 'compose-dag' | 'skill-fanout';
  /** The dispatch units, in dispatch order. */
  units: WaveUnit[];
}
