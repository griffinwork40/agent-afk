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
   * Set at TURN START so a busy session shows what it is doing now. Absent when
   * the first turn ended before a session id was minted (extremely rare) and no
   * raw text was passed to setPresenceActivityTurnEnd.
   *
   * "Raw user-typed" means the text BEFORE peer-message / bg-subagent-result
   * injections are prepended — those injections must never appear here.
   */
  promptHead?: string;
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
 *   3. Run through {@link redactSecrets} on the FULL collapsed string BEFORE
 *      truncating — truncating first can split a secret below the redactor's
 *      minimum match length (e.g. generic tokens need ≥32 chars, sk-ant- needs
 *      ≥20 chars after the prefix) and leave a near-complete credential.
 *   4. Truncate to {@link ACTIVITY_PROMPT_HEAD_MAX} characters.
 *
 * Returns `undefined` when the input is empty/whitespace-only after
 * normalization — the presence patch will leave any existing promptHead intact
 * in that case (see {@link setPresenceActivity}).
 */
export function normalizePromptHead(raw: string): string | undefined {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  // Invariant: redact before truncating so a secret straddling the boundary
  // is never split below the pattern's minimum match length.
  return redactSecrets(collapsed).slice(0, ACTIVITY_PROMPT_HEAD_MAX);
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
 * No-op when `rawText` normalizes to empty (e.g. whitespace-only input).
 * Note: plugin-forward ('/cmd …') and slash-command submit expansions produce
 * non-empty text (the command token itself, or the expanded message), so
 * promptHead IS written for those paths — only genuinely empty/whitespace-only
 * inputs are skipped. Best-effort and never throws.
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
 * Stamp `activity.turns` and `activity.lastTurnEndedAt` on this session's
 * presence file at TURN END.
 *
 * @param sessionId   The session whose presence file to update.
 * @param totalTurns  `ctx.stats.totalTurns` AFTER the turn was counted —
 *   stored directly rather than incrementing the presence file's own counter,
 *   so a resumed session starts from the correct historical total instead of
 *   resetting to 1 (presence-lifecycle.ts rewrites the record without activity
 *   on resume while stats.totalTurns is restored from the stored session).
 * @param rawUserText Optional RAW user-typed text for this turn. When provided
 *   and no promptHead has been recorded yet (e.g. first turn of a new session
 *   where ctx.stats.sessionId was undefined at turn start), it is stored as
 *   the promptHead so the first prompt is never silently lost. Never pass the
 *   composited runText — that would leak peer/bg-injection bodies.
 *
 * Best-effort and never throws.
 */
export async function setPresenceActivityTurnEnd(
  sessionId: string,
  totalTurns: number,
  rawUserText?: string,
): Promise<void> {
  return patchPresenceFile(sessionId, (rec) => {
    const prev = rec.activity;
    // Contract: if no promptHead has been written yet (first turn where sessionId
    // was undefined at turn start), seed it now from rawUserText. Never write
    // an empty string — omit the field if we have nothing useful.
    const head = prev?.promptHead !== undefined
      ? prev.promptHead
      : (rawUserText !== undefined ? normalizePromptHead(rawUserText) : undefined);
    rec.activity = {
      // promptHead is omitted rather than written as '' when absent. See JSDoc.
      ...(head !== undefined ? { promptHead: head } : {}),
      turns: totalTurns,
      lastTurnEndedAt: new Date().toISOString(),
    };
  });
}
