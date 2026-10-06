/**
 * Outcome session-end hook — immediate-pass labeling at root teardown.
 *
 * Wired alongside the facet hook in default-hook-registry.ts. At SessionEnd
 * for a root (non-forked) session:
 *   1. Loads the session turns (sidecar first, then journal fallback via loadOutcomeTurns).
 *   2. Recovers artifacts (commit SHAs, PR URLs, repo) from tool result previews.
 *      When the journal was the turn source (or exists alongside the sidecar),
 *      also walks subagents/*.jsonl for child commits and PRs (#2446).
 *   3. Runs all immediate LFs (closure, error_tail, verification,
 *      in_session_correction, self_report). Closure info is read from
 *      context.tracePath when available.
 *   4. Upserts into the outcome store as 'provisional' (settles_after = 7 days
 *      when artifacts present) or settled immediately otherwise.
 *   5. Stores first_prompt_tokens / first_cwd for cross_session_reask lookups.
 *      Raw prompt text is never written to disk (issue #2449).
 *
 * Child artifact attribution:
 *   - Primary: `recoverSubagentArtifacts` walks subagents/*.jsonl when a journal
 *     is present (covers all nesting depths via full tool results).
 *   - Fallback: the PostToolUse child-attribution hook remains active for
 *     sessions with no journal (old sessions, disabled journal).
 *
 * Fire-and-forget: never throws into or delays teardown.
 *
 * @module agent/outcomes/session-end-hook
 */

import { existsSync, readFileSync } from 'node:fs';
import type { HookHandler } from '../hooks.js';
import { isSubagentContext } from '../hooks/hook-utils.js';
import { loadOutcomeTurns, recoverSubagentArtifacts } from './load-outcome-turns.js';
import { recoverArtifacts } from './artifacts.js';
import { journalExists } from '../journal/reader.js';
import { runImmediateLFs, type ClosureInfo } from './lf-immediate.js';
import { upsertVotes } from './store.js';
import { lfReask, promptFingerprint } from './lf-reask.js';
import type { VerifiedOutcome } from './schema.js';
import type { Artifacts } from './schema.js';

// ---------------------------------------------------------------------------
// Closure reader — synchronous, reads tracePath written by the trace layer
// ---------------------------------------------------------------------------

/**
 * Read the closure reason from a sealed trace.jsonl file.
 * Returns null when tracePath is absent, the file doesn't exist, or parse fails.
 * This is the LoadClosure injectable required by lfClosure/runImmediateLFs.
 */
function closureFromTrace(tracePath: string | undefined): ClosureInfo | null {
  if (!tracePath || !existsSync(tracePath)) return null;
  try {
    const raw = readFileSync(tracePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj['kind'] === 'closure') {
          const p = obj['payload'] as Record<string, unknown> | undefined;
          const reason = p?.['reason'];
          if (reason === 'abort') return { reason: 'abort' };
          if (reason === 'iteration_cap') return { reason: 'iteration_cap' };
          // Invariant: only 'model_end_turn' should map to 'normal'.
          // 'truncated', 'timeout', 'budget_exceeded', 'hook_blocked', and
          // 'max_turns_exceeded' are abnormal termination reasons — mapping them
          // to 'normal' lets combiner rules 6/7 label abnormal sessions as
          // succeeded. Use 'unknown' as a safe non-normal sentinel for any
          // trace reason that is not explicitly known to be clean.
          if (reason === 'model_end_turn') return { reason: 'normal' };
          return { reason: 'unknown' };
        }
      } catch {
        // malformed line — skip
      }
    }
  } catch {
    // IO error
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session-kind detection
// ---------------------------------------------------------------------------

function detectSessionKind(
  turns: Array<{ toolEvents?: Array<{ toolName: string }> }>,
): VerifiedOutcome['session_kind'] {
  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch_apply']);
  for (const turn of turns) {
    for (const ev of turn.toolEvents ?? []) {
      if (WRITE_TOOLS.has(ev.toolName)) return 'mutating';
    }
  }
  return 'text';
}

// ---------------------------------------------------------------------------
// First prompt extraction
// ---------------------------------------------------------------------------

function extractFirstPrompt(
  turns: Array<{ user?: string }>,
): string | undefined {
  for (const turn of turns) {
    const text = turn.user?.trim();
    if (text) return text.slice(0, 2000); // cap at 2K chars
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * No-artifact sessions are held provisional for 24h so that a cross_session_reask
 * arriving later can still land a vote before the record is settled.
 * Previously these were settled immediately, causing them to never be revisited
 * by relabel-job.ts (which only processes provisional records).
 */
const NO_ARTIFACT_SETTLE_MS = 24 * 60 * 60 * 1000;

export function createOutcomeSessionEndHook(): HookHandler {
  return (context) => {
    if (context.event !== 'SessionEnd') return {};
    if (isSubagentContext(context)) return {};
    const sessionId = context.sessionId;
    if (!sessionId) return {};

    // Fire-and-forget: never block or throw into teardown
    void _runImmediatePass(sessionId, context.tracePath, context.cwd).catch(() => {});

    return {};
  };
}

// ---------------------------------------------------------------------------
// Artifact merge helper
// ---------------------------------------------------------------------------

/**
 * Merge `extra` artifacts into `base` without duplicating commits or PRs.
 * Mutates `base` in place and returns it.
 */
function mergeArtifacts(base: Artifacts, extra: Artifacts): Artifacts {
  const seenCommits = new Set(base.commits);
  for (const sha of extra.commits) {
    if (!seenCommits.has(sha)) {
      seenCommits.add(sha);
      base.commits.push(sha);
    }
  }
  const seenPrs = new Set(base.prs);
  for (const url of extra.prs) {
    if (!seenPrs.has(url)) {
      seenPrs.add(url);
      base.prs.push(url);
    }
  }
  if (base.repo === null && extra.repo !== null) {
    base.repo = extra.repo;
  }
  return base;
}

async function _runImmediatePass(
  sessionId: string,
  tracePath: string | undefined,
  cwd: string | undefined,
): Promise<void> {
  // Load session turns — sidecar first, journal fallback for scheduled/daemon
  // sessions that never write a sidecar (see load-outcome-turns.ts).
  const { turns, source } = loadOutcomeTurns(sessionId);

  // Recover artifacts from the main session turns.
  const artifacts = recoverArtifacts(turns);

  // When a journal is present (either as primary source or alongside the
  // sidecar), also walk subagents/*.jsonl to collect child commits/PRs.
  // This is the primary child-attribution path for journal-enabled sessions
  // (#2446); the PostToolUse hook remains the fallback for journal-absent runs.
  const hasJournal = source === 'journal' || journalExists(sessionId);
  if (hasJournal) {
    mergeArtifacts(artifacts, recoverSubagentArtifacts(sessionId));
  }

  const now = new Date().toISOString();
  const closure = closureFromTrace(tracePath);

  const { votes, selfReport } = runImmediateLFs(
    sessionId,
    turns,
    () => closure,
    now,
  );

  // Determine state / settles_after
  // No-artifact sessions are now written provisional with settles_after = 24h
  // so relabel-job can apply combiner v2 good-by-default and late reask signals
  // can still land before the record is settled (fixes the 'settled immediately'
  // regression where 563/564 unknown records could never be revisited).
  const hasArtifacts = artifacts.commits.length > 0 || artifacts.prs.length > 0;
  const settlesAfter = hasArtifacts
    ? new Date(Date.now() + SEVEN_DAYS_MS).toISOString()
    : new Date(Date.now() + NO_ARTIFACT_SETTLE_MS).toISOString();

  const sessionKind = detectSessionKind(turns);
  const firstPrompt = extractFirstPrompt(turns);

  const fingerprint = firstPrompt !== undefined ? promptFingerprint(firstPrompt) : [];

  // Map ClosureInfo → closure_reason field (stored in the outcome record).
  // 'unknown' is used when the trace was unavailable (closure === null).
  // The switch is exhaustive over ClosureInfo['reason'] so that adding a new
  // member to that union causes a compile-time error here rather than silently
  // falling through to a wrong value. The never assertion at default enforces
  // this — TypeScript will reject any unhandled branch.
  let closureReason: VerifiedOutcome['closure_reason'];
  if (closure === null) {
    closureReason = 'unknown';
  } else {
    switch (closure.reason) {
      case 'abort':
        closureReason = 'abort';
        break;
      case 'iteration_cap':
        closureReason = 'iteration_cap';
        break;
      case 'normal':
        closureReason = 'normal';
        break;
      case 'unknown':
        closureReason = 'unknown';
        break;
      default: {
        const _exhaustive: never = closure.reason;
        closureReason = 'unknown'; // unreachable at runtime
        void _exhaustive;
      }
    }
  }

  const base: Omit<VerifiedOutcome, 'votes' | 'history'> = {
    schema_version: 1,
    session_id: sessionId,
    label: 'unknown',
    confidence: 0,
    state: 'provisional',
    settles_after: settlesAfter,
    session_kind: sessionKind,
    self_report: selfReport,
    artifacts,
    closure_reason: closureReason,
    // session_ended_at is set once here and preserved across all later upsertVotes
    // calls (the store only writes it when absent). See schema.ts for rationale.
    session_ended_at: now,
    ...(fingerprint.length > 0 ? { first_prompt_tokens: fingerprint } : {}),
    ...(cwd !== undefined ? { first_cwd: cwd } : {}),
  };

  upsertVotes(sessionId, votes, base, { closureReason });

  // cross_session_reask: check if this NEW session should add a -1 to a
  // prior session (fire-and-forget within the already-void context)
  if (firstPrompt !== undefined) {
    void Promise.resolve().then(() => {
      try {
        lfReask(sessionId, firstPrompt, cwd, now);
      } catch {
        // best-effort
      }
    });
  }
}
