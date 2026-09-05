import { basename, dirname, join } from 'path';

import { getAfkStateDir } from './paths.js';

/**
 * Per-session witness-layer directory.
 *
 * Holds `trace.jsonl` and any compaction sidecars for the given session.
 * See `docs/philosophy/afk-contract.md` — the witness layer is the durable
 * evidence record for unattended (AFK) work.
 */
const SESSION_ID_SAFE = /^[a-zA-Z0-9_-]+$/;

export function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_SAFE.test(sessionId)) {
    throw new Error(
      `Invalid AFK_SESSION_ID: must match /^[a-zA-Z0-9_-]+$/, got: ${JSON.stringify(sessionId)}`,
    );
  }
}

/**
 * Root of the witness tree — the parent of every per-session trace directory.
 *
 * Canonical home for the path that `afk trace list`, the improve scanner, and
 * the retention sweep all need. Previously duplicated as a private helper in
 * `cli/commands/trace.ts` and `improve/paths.ts`.
 */
export function getWitnessRoot(): string {
  return join(getAfkStateDir(), 'witness');
}

export function getTraceDir(sessionId: string): string {
  validateSessionId(sessionId);
  return join(getWitnessRoot(), sessionId);
}

/** Session-scoped sidecars for human-supplied images addressable by subagents. */
export function getInboundAttachmentsDir(sessionId: string): string {
  return join(getTraceDir(sessionId), 'inbound-attachments');
}

/**
 * Directory for opt-in captured subagent dispatch prompts, keyed by the same
 * witness `sessionLabel` as {@link getTraceDir}.
 *
 * A forked child resumes its parent's sessionId, so a child writing here lands
 * in its PARENT's directory — which is what makes "every prompt this session
 * dispatched" a single-directory read. Pure path helper: the caller owns `mkdir`
 * (see `agent/session/subagent-prompt-capture.ts`).
 */
export function getPromptsDir(sessionId: string): string {
  return join(getTraceDir(sessionId), 'prompts');
}

/**
 * Directory for opt-in captured subagent conversational OUTPUT — the mirror of
 * {@link getPromptsDir}, which captures only what a child was *asked*.
 *
 * Same session-label keying and same fork semantics: a child resumes its
 * parent's sessionId, so one directory holds every child transcript a session
 * produced, keyed by `subagentId` filename. Pure path helper: the caller owns
 * `mkdir` (see `agent/session/subagent-output-capture.ts`).
 */
export function getSubagentOutputsDir(sessionId: string): string {
  return join(getTraceDir(sessionId), 'outputs');
}

/**
 * Session-scoped directory for bash output capture files.
 *
 * Captures live under the witness trace directory for the session so the
 * existing witness sweep (30-day / 2 GiB policy) evicts them automatically —
 * no separate sweeper is needed.
 *
 * Layout: `<getTraceDir(sessionId)>/bash-captures/`
 *
 * When `sessionId` is undefined or empty (e.g. the session has not yet
 * received a provider-assigned ID), returns `undefined` so the caller can
 * skip writing rather than accumulating files under an anonymous path.
 *
 * The directory itself should be created with mode 0o700 (owner only).
 * Individual capture files are written 0o600.
 */
export function getBashCapturesDir(sessionId: string | undefined): string | undefined {
  if (!sessionId || sessionId === '') return undefined;
  // Use getTraceDir which calls validateSessionId internally — provider-issued
  // session IDs must pass the same /^[A-Za-z0-9_-]+$/ constraint. If the ID
  // contains unexpected characters, the function throws; the caller wraps in
  // try/catch as part of best-effort capture.
  return join(getTraceDir(sessionId), 'bash-captures');
}

/**
 * Inverse of {@link getTraceDir}: recover the witness `sessionLabel` from a
 * trace-file path (`.../witness/<label>/trace.jsonl`).
 *
 * Returns `null` for the in-memory writer sentinel (`in-memory://trace`) and
 * for an absent path, so a caller recording the label can store an explicit
 * "no trace" marker rather than a bogus directory name. Used to stamp the
 * witness label into the session ledger's `meta` record — the trace writer
 * exposes only `getTracePath()` (its label is a random UUID it doesn't surface
 * directly), so the label is derived from that path.
 */
export function sessionLabelFromTracePath(tracePath: string | undefined | null): string | null {
  if (!tracePath || tracePath.startsWith('in-memory:')) return null;
  return basename(dirname(tracePath));
}

/**
 * Directory for post-session run receipts.
 *
 * Each completed top-level session writes `<label>.json` + `<label>.md` here,
 * keyed by the witness-trace label so a receipt sits 1:1 with the trace it
 * summarizes (see `src/agent/trace/receipt.ts`). Read-only derivatives of the
 * sealed witness trace — they carry no state the trace doesn't already hold.
 */
export function getReceiptsDir(): string {
  return join(getAfkStateDir(), 'receipts');
}
