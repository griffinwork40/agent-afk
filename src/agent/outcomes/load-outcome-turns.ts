/**
 * Outcome turn loader — sidecar with journal fallback; subagent artifact recovery.
 *
 * `loadOutcomeTurns(sessionId)` is the single entry point that session-end-hook.ts
 * uses to obtain a Turn[] for labeling. It tries the session sidecar first
 * (fast, already-structured), then falls back to the message journal when the
 * sidecar is absent or empty.
 *
 * `recoverSubagentArtifacts(sessionId)` walks every subagent journal under
 * `sessions/<id>/subagents/*.jsonl` and returns the merged artifact set
 * (commit SHAs + PR URLs) found in child tool results. This is the primary
 * path for child artifact attribution when a journal is present, replacing the
 * PostToolUse hook for sessions that land journal entries.
 *
 * Error posture: never throws. Any failure (missing sidecar, unreadable
 * journal, malformed records) degrades to `{ turns: [], source: 'none' }` so
 * the hook's fire-and-forget contract is preserved.
 *
 * Dependency direction: outcomes → journal (not the reverse).
 *
 * @module agent/outcomes/load-outcome-turns
 */

import { loadStoredSession } from '../facets/store.js';
import { readJournalRecords, hydrateMessages, listSubagentJournals } from '../journal/reader.js';
import type { JournalMessage, JournalRecord } from '../journal/types.js';
import { journalMessagesToTurns } from './journal-turns.js';
import { recoverArtifacts } from './artifacts.js';
import type { Turn } from './artifacts.js';
import type { Artifacts } from './schema.js';

export type OutcomeTurnsSource = 'sidecar' | 'journal' | 'none';

export interface OutcomeTurnsResult {
  turns: Turn[];
  source: OutcomeTurnsSource;
}

/**
 * Load Turn[] for a session, preferring the sidecar and falling back to the
 * message journal when the sidecar is absent or has no turns.
 *
 * "Absent" covers: file does not exist, parse failure, and sessions.turns
 * being empty — all three leave the outcome hook with no labeling signal.
 * Scheduled/daemon sessions never write the sidecar at all; for those the
 * journal is the only source.
 */
export function loadOutcomeTurns(sessionId: string): OutcomeTurnsResult {
  // 1. Try the sidecar first. An independent try/catch ensures that a corrupt
  //    or throwing sidecar does not skip the journal fallback — both branches
  //    are independently guarded.
  try {
    const session = loadStoredSession(sessionId);
    if (session !== undefined && session.turns.length > 0) {
      // Sidecar turns already carry the Turn / ToolEvent shape; pass through.
      return { turns: session.turns, source: 'sidecar' };
    }
  } catch {
    // Sidecar read failed (corrupt file, permission, parse error). Fall through
    // to the journal path rather than surfacing 'none' prematurely.
  }

  // 2. Fall back to the journal.
  try {
    const messages = sessionHistoryMessages(readJournalRecords(sessionId));
    if (messages.length === 0) {
      return { turns: [], source: 'none' };
    }

    // Hydrate spilled blob references before converting (best-effort; a
    // missing blob becomes a stand-in text block — never throws).
    const turns = journalMessagesToTurns(hydrateMessages(messages));
    return { turns, source: turns.length > 0 ? 'journal' : 'none' };
  } catch {
    // Any unexpected error (path validation, permission, etc.) degrades to
    // an empty result exactly like a missing sidecar.
    return { turns: [], source: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Subagent artifact recovery from child journals
// ---------------------------------------------------------------------------

/**
 * Walk every subagent journal under `sessions/<id>/subagents/*.jsonl` and
 * return the merged Artifacts found in child tool results.
 *
 * This is the primary child-attribution path when the session has a message
 * journal. It covers all nesting depths — each subagent journal records the
 * child's own tool results, so grandchild commits/PRs appear in the child's
 * subagent journal and the child's journal is under the root session's
 * subagents/ dir.
 *
 * Error posture: never throws. A failing subagent journal is skipped silently.
 * The existing PostToolUse child-attribution hook remains active as a fallback
 * for sessions where the journal is absent or disabled.
 */
export function recoverSubagentArtifacts(sessionId: string): Artifacts {
  const merged: Artifacts = { commits: [], prs: [], repo: null };
  const seenCommits = new Set<string>();
  const seenPrs = new Set<string>();

  let subagentIds: string[];
  try {
    subagentIds = listSubagentJournals(sessionId);
  } catch {
    return merged;
  }

  for (const subagentId of subagentIds) {
    try {
      const records = readJournalRecords(sessionId, { subagentId });
      const messages = sessionHistoryMessages(records);
      if (messages.length === 0) continue;
      const turns = journalMessagesToTurns(hydrateMessages(messages));
      const childArtifacts = recoverArtifacts(turns);
      for (const sha of childArtifacts.commits) {
        if (!seenCommits.has(sha)) {
          seenCommits.add(sha);
          merged.commits.push(sha);
        }
      }
      for (const url of childArtifacts.prs) {
        if (!seenPrs.has(url)) {
          seenPrs.add(url);
          merged.prs.push(url);
        }
      }
      if (merged.repo === null && childArtifacts.repo !== null) {
        merged.repo = childArtifacts.repo;
      }
    } catch {
      // Skip this subagent journal — never propagate into the hook's
      // fire-and-forget context.
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// History message extraction
// ---------------------------------------------------------------------------

/**
 * Invariant: outcome labeling needs everything the session DID, not what the
 * model can still see. The folded journal (loadJournalFold) applies
 * `truncate` records (compact, resync, rewind, clear, repair,
 * provider_switch), which drop messages from the model context but not from
 * history: a commit or a failing test before a compaction still happened.
 * The sidecar keeps every turn for the same reason, and facets'
 * journalRecordsToToolEvents scans all appends too. So we take every
 * `append` in record order and skip verbatim re-appends (resync / compaction
 * replay the same message at the same index), which would otherwise duplicate
 * turns and tool events.
 *
 * Dedup is fingerprint-based per slot: for each journal index we track a
 * short fingerprint (role + serialized type/id of the first content block,
 * capped at 120 chars). An append at the same index with the same fingerprint
 * is a verbatim resync replay and is skipped. An append at the same index
 * with a different fingerprint is a distinct historical event (e.g. a
 * compaction summary replacing the prior turn) and is included. This avoids
 * the unbounded-key problem of full `JSON.stringify(rec.message)` while
 * correctly including legitimately repeated messages (same text, different
 * index) and distinct messages at the same slot.
 */
export function sessionHistoryMessages(records: readonly JournalRecord[]): JournalMessage[] {
  // Per-slot fingerprint of the last message written at that index.
  const slotFp = new Map<number, string>();
  const out: JournalMessage[] = [];
  for (const rec of records) {
    if (rec.kind !== 'append') continue;
    // Fingerprint: role + compact representation of the first content block.
    // We only need enough to distinguish tool_use/tool_result (which carry
    // unique IDs) from text blocks. Cap at 120 chars to bound allocation.
    const firstBlock = rec.message.content[0];
    const blockKey = firstBlock
      ? JSON.stringify(firstBlock).slice(0, 120)
      : '';
    const fp = `${rec.message.role}|${blockKey}`;
    if (slotFp.get(rec.index) === fp) continue; // verbatim replay — skip
    slotFp.set(rec.index, fp);
    out.push(rec.message);
  }
  return out;
}
