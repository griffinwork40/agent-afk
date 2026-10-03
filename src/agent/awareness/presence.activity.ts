/**
 * Activity extensions to the presence layer: the optional `activity` field on
 * {@link PresenceFileInfo}, written at REPL turn boundaries so peer sessions
 * can see what a session is working on via `list_sessions`.
 *
 * Invariant: every mutator routes through `patchPresenceFile`, i.e. through
 * presence.ts's single per-session write queue. A private queue here would let
 * an activity write race concurrent heartbeat / turnState / blockedSince
 * mutations and silently drop one another's changes.
 * All helpers are best-effort and never throw: presence is non-critical.
 *
 * promptHead source: always the RAW user-typed text, before any peer-message or
 * background-subagent-result injections are prepended. This is critical: peer
 * message bodies must NEVER leak into another session's presence file, because
 * the presence directory is readable by any process on the same machine running
 * as the same user.
 *
 * @module agent/awareness/presence.activity
 */

import { patchPresenceFile } from './presence.js';
import { redactSecrets } from '../redact-secrets.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length (characters) of {@link PresenceActivity.promptHead}. */
export const ACTIVITY_PROMPT_HEAD_MAX = 120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a session is (or was last) working on. Written at turn start (promptHead)
 * and turn end (turns / lastTurnEndedAt). Optional on PresenceFileInfo — absent
 * for sessions that have never completed a turn, or sessions on non-REPL
 * surfaces.
 *
 * lastToolName is intentionally omitted: sourcing it cheaply requires new
 * cross-cutting plumbing (the turn-run loop has no cheap access to last-tool
 * after runTurn returns), and the marginal value is low given that `read_witness`
 * already exposes full tool call history for any session.
 */
export interface PresenceActivity {
  /**
   * First ≤120 chars of the raw user-typed text for this turn, after whitespace
   * collapsing and newline normalization, passed through `redactSecrets`.
   * Set at TURN START so a busy session shows what it is doing now.
   *
   * "Raw user-typed" means the text BEFORE peer-message / bg-subagent-result
   * injections are prepended — those injections must never appear here.
   */
  promptHead: string;
  /**
   * Total completed turns for this session. Incremented at turn end.
   * Zero until the first turn completes.
   */
  turns: number;
  /**
   * ISO 8601 timestamp of when the most recent turn completed. Set at turn end.
   * Absent until the first turn completes.
   */
  lastTurnEndedAt?: string;
}

// ---------------------------------------------------------------------------
// normalizePromptHead
// ---------------------------------------------------------------------------

/**
 * Normalize raw user text for safe storage in the presence file:
 *   1. Collapse all whitespace runs (newlines, tabs, etc.) to a single space.
 *   2. Trim leading/trailing whitespace.
 *   3. Truncate to {@link ACTIVITY_PROMPT_HEAD_MAX} characters.
 *   4. Run through {@link redactSecrets} to strip common token patterns.
 *
 * Returns `undefined` when the input is empty/whitespace-only after
 * normalization — the presence patch will leave any existing promptHead intact
 * in that case (see {@link setPresenceActivity}).
 */
export function normalizePromptHead(raw: string): string | undefined {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  const truncated = collapsed.slice(0, ACTIVITY_PROMPT_HEAD_MAX);
  return redactSecrets(truncated);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the `activity.promptHead` on this session's presence file at TURN START.
 *
 * Should be called with the RAW user-typed text, BEFORE any injections are
 * prepended (peer messages, bg-subagent results, etc.).
 *
 * No-op when `rawText` normalizes to empty (e.g. a slash-command expansion
 * where the original text is the command name; in that case the previous
 * promptHead is preserved). Best-effort and never throws.
 */
export async function setPresenceActivityPromptHead(
  sessionId: string,
  rawText: string,
): Promise<void> {
  const head = normalizePromptHead(rawText);
  if (head === undefined) return;
  return patchPresenceFile(sessionId, (rec) => {
    // Contract: rec.activity may not exist yet on the first turn. Preserve
    // existing turns/lastTurnEndedAt from a prior turn end.
    const prev = rec.activity;
    rec.activity = {
      promptHead: head,
      turns: prev?.turns ?? 0,
      ...(prev?.lastTurnEndedAt !== undefined ? { lastTurnEndedAt: prev.lastTurnEndedAt } : {}),
    };
  });
}

/**
 * Increment `activity.turns` and stamp `activity.lastTurnEndedAt` on this
 * session's presence file at TURN END.
 *
 * Best-effort and never throws.
 */
export async function setPresenceActivityTurnEnd(sessionId: string): Promise<void> {
  return patchPresenceFile(sessionId, (rec) => {
    const prev = rec.activity;
    rec.activity = {
      promptHead: prev?.promptHead ?? '',
      turns: (prev?.turns ?? 0) + 1,
      lastTurnEndedAt: new Date().toISOString(),
    };
  });
}
