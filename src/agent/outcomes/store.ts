/**
 * Outcome store — read/write for VerifiedOutcome records.
 *
 * Records live at ~/.afk/agent-framework/outcomes/<sessionId>.json via
 * getOutcomesDir() / getOutcomeRecordPath() from src/paths.ts. Writes are
 * atomic (tmp+rename, same protocol as the facet yield patch). Validation uses
 * the Zod schema from schema.ts.
 *
 * Design: docs/proposals/verified-outcome.md § Storage
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { getOutcomesDir, getOutcomeRecordPath, validateSessionId } from '../../paths.js';
import { VerifiedOutcomeSchema, type VerifiedOutcome, type Vote } from './schema.js';
import { combine } from './combine.js';
import { atomicWriteFile } from '../../utils/atomic-write.js';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read a VerifiedOutcome record from disk. Returns undefined on miss or
 * validation failure (treat both as "no record yet").
 */
export function readRecord(
  sessionId: string,
  outcomesDir: string = getOutcomesDir(),
): VerifiedOutcome | undefined {
  validateSessionId(sessionId);
  const path = _recordPath(sessionId, outcomesDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = VerifiedOutcomeSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Write — atomic tmp+rename
// ---------------------------------------------------------------------------

/**
 * Write a VerifiedOutcome record atomically. Validates with Zod before
 * writing; throws ZodError on invalid data.
 */
export function writeRecord(
  outcome: VerifiedOutcome,
  outcomesDir: string = getOutcomesDir(),
): void {
  VerifiedOutcomeSchema.parse(outcome); // throws on invalid
  const path = _recordPath(outcome.session_id, outcomesDir);
  atomicWriteFile(path, `${JSON.stringify(outcome, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// List — bounded scan for nightly relabel jobs
// ---------------------------------------------------------------------------

/**
 * List session IDs with stored outcome records, up to `limit`.
 * Skips non-.json entries. Returns IDs in directory listing order (no sort
 * guarantee — callers that need ordering should sort themselves).
 */
export function listRecords(
  limit = 1000,
  outcomesDir: string = getOutcomesDir(),
): string[] {
  if (!existsSync(outcomesDir)) return [];
  const ids: string[] = [];
  try {
    for (const entry of readdirSync(outcomesDir)) {
      if (!entry.endsWith('.json')) continue;
      ids.push(entry.slice(0, -5));
      if (ids.length >= limit) break;
    }
  } catch {
    return [];
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Upsert votes — merge, re-combine, append history on label change
// ---------------------------------------------------------------------------

export interface UpsertVotesOptions {
  /** Override the outcomes directory (default: getOutcomesDir()). */
  outcomesDir?: string;
  /**
   * Closure reason to store in the record (supplied at immediate-LF time via
   * the witness trace). When omitted the existing record value is preserved.
   * Callers that don't know the closure reason (e.g. relabel-job) should omit
   * this — the value written at session-end time is authoritative.
   */
  closureReason?: VerifiedOutcome['closure_reason'];
}

/**
 * Merge `newVotes` into the outcome record for `sessionId`, re-run the
 * combiner, and persist atomically. Creates a new skeleton record when none
 * exists yet (requires `base` to be supplied). History is appended only when
 * the computed label changes. Deduplication: a vote is considered a duplicate
 * if an existing vote shares the same `lf` and `evidence` pair — the incoming
 * vote replaces it (idempotent re-submission updates observed_at / strength).
 *
 * explicit_feedback override semantics (design §"Explicit feedback"):
 *   - A vote with lf === 'explicit_feedback' causes upsertVotes to call
 *     combine() with explicit_feedback set, so the combiner produces
 *     succeeded/failed at confidence 1.0 / settled immediately.
 *   - The MOST RECENT explicit_feedback vote (by observed_at, ties broken by
 *     later position) decides the override. Multiple explicit_feedback votes
 *     with different evidence values (e.g. "/good" then "/bad some reason")
 *     are all preserved in votes[] for audit; only the newest drives the label.
 *   - Other votes are STILL appended to votes[] and history[], so a /good
 *     session whose commit is reverted remains visible as a disagreement.
 */
export function upsertVotes(
  sessionId: string,
  newVotes: Vote[],
  base?: Omit<VerifiedOutcome, 'votes' | 'history'>,
  opts: UpsertVotesOptions = {},
): VerifiedOutcome {
  validateSessionId(sessionId);
  const outcomesDir = opts.outcomesDir ?? getOutcomesDir();
  const existing = readRecord(sessionId, outcomesDir);

  // Build the record to mutate
  const record: VerifiedOutcome = existing ?? _skeleton(sessionId, base);

  // Persist closure reason when supplied (only at immediate-LF time).
  // Preserve the existing value when the caller does not know it (relabel-job etc.)
  if (opts.closureReason !== undefined) {
    record.closure_reason = opts.closureReason;
  }

  // Backfill closure_reason from base when the existing record lacks it and
  // opts.closureReason was not supplied. This covers the race where
  // appendArtifacts creates a skeleton (no base → no closure_reason) and the
  // later session-end upsertVotes finds the existing skeleton.  Without the
  // backfill the skeleton's absent closure_reason causes normalClosure to fall
  // back to the conservative 'treat as normal' default, which is incorrect for
  // abnormal terminations already captured in base.
  if (record.closure_reason === undefined && base?.closure_reason !== undefined && opts.closureReason === undefined) {
    record.closure_reason = base.closure_reason;
  }

  // session_ended_at is immutable after first write — preserve the existing
  // value across all subsequent upsertVotes calls (relabel-job, reask, etc.).
  // The base record from the session-end hook supplies the initial value.
  // Backfill from base when the existing record (e.g. an appendArtifacts
  // skeleton) lacks it — without backfill, lf-reask falls back to mtime for
  // sessions where a child artifact arrived before session teardown.
  if (record.session_ended_at === undefined && base?.session_ended_at !== undefined) {
    record.session_ended_at = base.session_ended_at;
  }

  // Merge votes: dedupe by lf+evidence (incoming wins on collision)
  const merged = _mergeVotes(record.votes, newVotes);
  record.votes = merged;

  // Detect explicit_feedback override — pick the most recent vote by observed_at
  // (ties broken by later array position). Rationale: /good then /bad some-note
  // leaves two explicit_feedback votes with different evidence values; the
  // earliest .find() would return the stale /good. Newest-wins ensures the last
  // operator action is authoritative while both votes stay in votes[] for audit.
  const efVote = _latestExplicitFeedback(merged);
  const explicitFeedback = efVote
    ? efVote.vote === 1
      ? ('good' as const)
      : ('bad' as const)
    : undefined;

  // Determine whether the settle window has passed (for good-by-default rule)
  const nowMs = Date.now();
  const settleWindowPassed =
    record.settles_after !== null &&
    nowMs > new Date(record.settles_after).getTime();

  // Derive normalClosure from stored closure_reason.
  // Records without closure_reason (written before this field was added) are
  // treated as normal closure (conservative: we don't know it was abnormal).
  // Non-normal values are: 'abort', 'iteration_cap', 'unknown'.
  // The field is populated at session-end time by closureFromTrace() in
  // src/agent/outcomes/session-end-hook.ts — if a new ClosureReason member is
  // added there, update this whitelist and the exhaustive switch in that file.
  const normalClosure =
    record.closure_reason === undefined ||
    record.closure_reason === 'normal';

  // Re-combine
  const { label, confidence, basis } = combine({
    votes: merged,
    selfReport: record.self_report,
    artifacts: record.artifacts,
    explicit_feedback: explicitFeedback,
    settleWindowPassed,
    normalClosure,
  });

  // Settle immediately when explicit_feedback overrides
  const state: VerifiedOutcome['state'] = explicitFeedback ? 'settled' : record.state;
  const settlesAfter = explicitFeedback ? null : record.settles_after;

  // Append history only when label changes
  if (label !== record.label) {
    record.history = [
      ...record.history,
      {
        at: new Date().toISOString(),
        label,
        reason: _historyReason(newVotes),
      },
    ];
  }

  record.label = label;
  record.confidence = confidence;
  record.state = state;
  record.settles_after = settlesAfter;
  if (basis !== undefined) {
    record.basis = basis;
  } else {
    // Clear stale basis when combiner returns unknown/blocked
    delete record.basis;
  }

  writeRecord(record, outcomesDir);
  return record;
}

// ---------------------------------------------------------------------------
// Append artifacts — used by child attribution at tool-call time
// ---------------------------------------------------------------------------

/**
 * Merge new commit SHAs and PR URLs into an existing outcome record's
 * artifacts, then re-persist. If no record exists yet, creates a skeleton.
 * Flips state to 'provisional' with a 7-day settles_after when the record
 * was settled and new artifacts arrive (rare: attribution race).
 *
 * Read-modify-write: re-reads the record immediately before writing to
 * minimize races between parent teardown and child PostToolUse dispatches.
 * The atomic rename ensures no partial writes are observed.
 */
export function appendArtifacts(
  sessionId: string,
  incoming: { commits?: string[]; prs?: string[]; repo?: string | null },
  opts: UpsertVotesOptions = {},
): void {
  validateSessionId(sessionId);
  const outcomesDir = opts.outcomesDir ?? getOutcomesDir();
  // Re-read right before writing to catch concurrent parent writes
  const existing = readRecord(sessionId, outcomesDir);
  const record: VerifiedOutcome = existing ?? _skeleton(sessionId);

  // Merge deduplicated commits + prs
  const commitsSet = new Set(record.artifacts.commits);
  for (const sha of incoming.commits ?? []) commitsSet.add(sha);

  const prsSet = new Set(record.artifacts.prs);
  for (const url of incoming.prs ?? []) prsSet.add(url);

  record.artifacts = {
    commits: Array.from(commitsSet),
    prs: Array.from(prsSet),
    repo: record.artifacts.repo ?? incoming.repo ?? null,
  };

  // If artifacts arrived and record was settled, flip back to provisional
  const hasNew =
    (incoming.commits?.length ?? 0) > 0 || (incoming.prs?.length ?? 0) > 0;
  if (hasNew && record.state === 'settled' && record.settles_after === null) {
    record.state = 'provisional';
    record.settles_after = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  writeRecord(record, outcomesDir);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _recordPath(sessionId: string, outcomesDir: string): string {
  if (outcomesDir === getOutcomesDir()) {
    return getOutcomeRecordPath(sessionId);
  }
  return `${outcomesDir}/${sessionId}.json`;
}

/**
 * Return the most recent explicit_feedback vote from `votes` (by observed_at,
 * ties broken by later position in the array). Returns undefined when none
 * exist. This is the vote that drives the explicit_feedback override in
 * upsertVotes — always use this instead of Array.find() so the last operator
 * action wins even when multiple explicit_feedback votes have different
 * evidence values (e.g. "/good" then "/bad some reason").
 */
function _latestExplicitFeedback(votes: Vote[]): Vote | undefined {
  let latest: Vote | undefined;
  for (const v of votes) {
    if (v.lf !== 'explicit_feedback') continue;
    if (
      latest === undefined ||
      // Tie-break: later position wins on equal timestamps (>= replaces the
      // prior > … || === pair, which was correct but unnecessarily verbose).
      v.observed_at >= latest.observed_at
    ) {
      latest = v;
    }
  }
  return latest;
}

function _mergeVotes(existing: Vote[], incoming: Vote[]): Vote[] {
  // Index existing by lf+evidence key
  const map = new Map<string, Vote>();
  for (const v of existing) {
    map.set(`${v.lf}\x00${v.evidence}`, v);
  }
  // Incoming replaces on collision (idempotent re-submission).
  // delete-then-set preserves Map insertion order: the updated entry moves to
  // the end so _latestExplicitFeedback's forward scan sees arrival order, not
  // the position of the first occurrence of this key.
  for (const v of incoming) {
    const key = `${v.lf}\x00${v.evidence}`;
    map.delete(key);
    map.set(key, v);
  }
  return Array.from(map.values());
}

function _historyReason(newVotes: Vote[]): string {
  if (newVotes.length === 0) return 'recomputed';
  const lfs = [...new Set(newVotes.map((v) => v.lf))].join(', ');
  return `votes added: ${lfs}`;
}

function _skeleton(
  sessionId: string,
  base?: Omit<VerifiedOutcome, 'votes' | 'history'>,
): VerifiedOutcome {
  return {
    schema_version: 1,
    session_id: sessionId,
    label: 'unknown',
    confidence: 0,
    state: 'provisional',
    settles_after: base?.settles_after ?? null,
    session_kind: base?.session_kind ?? 'text',
    self_report: base?.self_report ?? 'none',
    artifacts: base?.artifacts ?? { commits: [], prs: [], repo: null },
    votes: [],
    history: [],
    ...base,
  };
}
