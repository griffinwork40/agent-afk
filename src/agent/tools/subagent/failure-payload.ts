/**
 * Failure-path payload + telemetry shaping helpers.
 *
 * Extracted from `subagent-executor.ts`: the best-effort telemetry wrapper and
 * the small pure helpers that shape the structured JSON failure payload
 * returned to the parent model. Shared by the fork-error, background, and
 * foreground paths in `execute()`. All functions are pure — no dependency on
 * the executor instance.
 *
 * @module agent/tools/subagent/failure-payload
 */

import { appendRoutingDecision } from '../../routing-telemetry.js';

/**
 * Best-effort telemetry helper. Wraps {@link appendRoutingDecision} so a
 * synchronous throw (shouldn't happen — the helper already swallows) cannot
 * propagate into the dispatch path.
 */
export function emitTelemetry(entry: Parameters<typeof appendRoutingDecision>[0]): Promise<void> {
  try {
    return appendRoutingDecision(entry).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Truncate short telemetry strings; we never log full error bodies. */
export function truncate(s: string, max = 240): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/**
 * Maximum length applied to `stopReason` everywhere it is persisted or
 * emitted. On the OpenAI-compatible path `stopReason` is provider-controlled
 * free text (`providers/openai-compatible/translate.ts`,
 * `responses-translate.ts`), not a bounded enum, so it must never ride
 * uncapped into a telemetry row or a durable artifact.
 */
const MAX_STOP_REASON_CHARS = 64;

/**
 * Single chokepoint for bounding `stopReason` before it leaves the process
 * boundary (telemetry emit or `meta.json` persistence). Every call site that
 * touches `SubagentResult.stopReason` downstream of the fork/promotion layer
 * must route through this helper instead of inlining its own
 * `truncate(x, 64)` — a hand-duplicated bound is how the unbounded
 * `writeMeta` site (#717) went unnoticed for three of its four siblings.
 * Preserves omit-when-absent: `undefined` stays `undefined`, never `''`.
 */
export function boundedStopReason(stopReason: string | undefined): string | undefined {
  return stopReason !== undefined ? truncate(stopReason, MAX_STOP_REASON_CHARS) : undefined;
}

/** Measure partial output size without serializing large structures repeatedly. */
export function measurePartial(partial: unknown): number | undefined {
  if (partial === undefined || partial === null) return undefined;
  if (typeof partial === 'string') return partial.length;
  try {
    return JSON.stringify(partial).length;
  } catch {
    return undefined;
  }
}

/**
 * Maximum serialized size of `partialOutput` we will surface to the parent
 * model. Above this, we replace the payload with a `{ truncated, chars }`
 * marker so the parent learns partial output existed without flooding its
 * context.
 */
const MAX_PARTIAL_OUTPUT_CHARS = 4096;

/** Maximum length of the `error` field in the structured failure payload. */
const MAX_ERROR_MESSAGE_CHARS = 1024;

/**
 * Shape a partial output for inclusion in the structured failure payload.
 * Returns `undefined` when the input is null/undefined (key is omitted).
 * Returns a `{ truncated, chars }` marker when serialization exceeds the cap.
 */
function shapePartialOutput(
  partial: unknown,
): unknown | undefined {
  if (partial === undefined || partial === null) return undefined;
  const chars = measurePartial(partial);
  if (chars !== undefined && chars > MAX_PARTIAL_OUTPUT_CHARS) {
    return { truncated: true, chars };
  }
  return partial;
}

/**
 * Build the structured JSON payload returned to the parent model on the
 * failure path. Intentionally small: status + short error + optional schema
 * error string + optional (size-capped) partial output + subagent id +
 * optional worktree context (cwd, branch, headSha, dirtyCount).
 *
 * Excludes by design: prompts, full subagent assistant messages, file
 * contents, tool inputs/outputs, credentials, stack traces.
 */
export interface StructuredFailurePayload {
  status: string;
  error: string;
  schemaError?: string;
  partialOutput?: unknown;
  subagent_id: string;
  /**
   * Working directory of the failed child, when it was dispatched with an
   * explicit `cwd` (worktree-isolated or cwd-override runs). Absent for
   * children sharing the parent's cwd. Lets the parent rediscover the
   * worktree without listing all worktrees.
   */
  cwd?: string;
  /**
   * Git branch name of the child's worktree at failure time, when available.
   * Absent when the child had no cwd, the cwd is not a git repo, or the
   * branch could not be determined (detached HEAD, git not found, etc.).
   */
  branch?: string;
  /**
   * HEAD commit SHA of the child's worktree at failure time (40-char hex),
   * when available. Same availability conditions as {@link branch}.
   */
  headSha?: string;
  /**
   * Number of dirty (modified/untracked) files in the child's worktree at
   * failure time, when available. Useful for quick triage: 0 means the
   * worktree is clean and can be removed; >0 means work may need recovery.
   */
  dirtyCount?: number;
}

/**
 * Snapshot of a child's worktree git state at failure time.
 * All fields are optional — the caller supplies only what it can read
 * cheaply without blocking.
 */
export interface WorktreeContext {
  cwd: string;
  branch?: string;
  headSha?: string;
  dirtyCount?: number;
}

export function buildFailurePayload(args: {
  status: string;
  errorMessage: string;
  schemaErrorMessage?: string;
  partialOutput?: unknown;
  subagentId: string;
  worktreeContext?: WorktreeContext;
}): StructuredFailurePayload {
  const payload: StructuredFailurePayload = {
    status: args.status,
    error: truncate(args.errorMessage, MAX_ERROR_MESSAGE_CHARS),
    subagent_id: args.subagentId,
  };
  if (args.schemaErrorMessage) {
    payload.schemaError = truncate(args.schemaErrorMessage, MAX_ERROR_MESSAGE_CHARS);
  }
  const shaped = shapePartialOutput(args.partialOutput);
  if (shaped !== undefined) {
    payload.partialOutput = shaped;
  }
  if (args.worktreeContext !== undefined) {
    const wt = args.worktreeContext;
    payload.cwd = wt.cwd;
    if (wt.branch !== undefined) payload.branch = wt.branch;
    if (wt.headSha !== undefined) payload.headSha = wt.headSha;
    if (wt.dirtyCount !== undefined) payload.dirtyCount = wt.dirtyCount;
  }
  return payload;
}
