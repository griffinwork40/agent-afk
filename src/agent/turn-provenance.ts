/**
 * Per-turn origin primitive (PR A of issue #2906).
 *
 * Records what started the current model turn so consumers — PreToolUse
 * hooks, presence activity, peer envelopes, subagent inheritance, and the
 * witness trace — no longer have to guess from `surface` or interactive checks.
 *
 * ## Design
 * - `TurnOrigin` is a four-value discriminant covering every entry path the
 *   harness has today.  Values are intentionally stable strings (not enums) so
 *   JSONL traces and Zod schemas can validate them without importing this module.
 * - `TurnProvenance` is the per-turn record threaded through the turn boundary.
 * - `peerInfluenced` is flipped to `true` by the boundary injection path the
 *   moment a peer-session envelope is prepended to the running text; it stays
 *   `false` for background-subagent results and shell passthrough injections.
 *
 * ## PR phasing (issue #2906)
 * - **PR A (this file):** define types + Zod schema; set provenance in the
 *   REPL, Telegram, and daemon loops; expose from `AgentConfig`; thread into
 *   PreToolUse context payload, witness trace (`session_phase` `loop_start`
 *   extension), presence activity, subagent inheritance, and peer envelope.
 *   NO behaviour change — data plumbing only.
 * - **PR B:** PreToolUse enforcement hook (blocks/asks on non-human turns).
 * - **PR C:** `ask_question` answerability uses provenance.
 *
 * @module agent/turn-provenance
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What initiated the current model turn.
 *
 * - `'human'`     — a live operator typed a message (REPL readline or Telegram
 *                   message handler).  A human is watching.
 * - `'peer'`      — the turn was woken by an auto-resume directive whose sole
 *                   injection source was one or more peer-session messages (no
 *                   background subagent results in the same envelope set).
 * - `'background'` — the turn was woken by a settled background-subagent or
 *                   background-process result (the `[auto-resume]` path where
 *                   `bgResultPending === true`).
 * - `'scheduled'` — the turn was spawned by the daemon scheduler (cron /
 *                   sessionstart / pull triggers).
 */
export type TurnOrigin = 'human' | 'peer' | 'background' | 'scheduled';

/**
 * Per-turn provenance record.  Constructed once at turn-start by the surface
 * loop and threaded through the turn boundary so every consumer reads from a
 * single shared object rather than re-inferring origin independently.
 */
export interface TurnProvenance {
  /** What initiated this turn. */
  origin: TurnOrigin;
  /**
   * `true` when at least one peer-session envelope was prepended to this
   * turn's running text (regardless of `origin`).  Flipped by
   * `markTurnPeerInfluenced` in the boundary injection path.
   *
   * Invariant: always `false` when `origin === 'scheduled'` (daemon sessions
   * have no peer injection path today).
   */
  peerInfluenced: boolean;
}

// ---------------------------------------------------------------------------
// Zod schema (used by trace events.ts and presence validation)
// ---------------------------------------------------------------------------

export const TurnOriginSchema = z.enum(['human', 'peer', 'background', 'scheduled']);

export const TurnProvenanceSchema = z.object({
  origin: TurnOriginSchema,
  peerInfluenced: z.boolean(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construct a fresh `TurnProvenance` for a human-initiated REPL or Telegram
 * turn.  `peerInfluenced` starts `false`; it is flipped later when the
 * boundary injection path prepends a peer envelope.
 */
export function humanTurnProvenance(): TurnProvenance {
  return { origin: 'human', peerInfluenced: false };
}

/**
 * Construct a `TurnProvenance` for a turn woken by an auto-resume directive.
 *
 * @param bgResultPending - mirrors the same flag passed to `autoResumeDirective`:
 *   `true` when a settled background-subagent or background-process result
 *   triggered the wake (→ `'background'`); `false` when only peer messages
 *   did (→ `'peer'`).
 */
export function autoResumeTurnProvenance(bgResultPending: boolean): TurnProvenance {
  return { origin: bgResultPending ? 'background' : 'peer', peerInfluenced: !bgResultPending };
}

/**
 * Construct a `TurnProvenance` for a daemon-scheduled turn.
 */
export function scheduledTurnProvenance(): TurnProvenance {
  return { origin: 'scheduled', peerInfluenced: false };
}

/**
 * Flip `peerInfluenced` to `true` on an existing provenance object.
 * Called by the boundary injection path the moment a peer envelope is prepended.
 * Mutates in place (the object is owned by the current-turn scope).
 */
export function markTurnPeerInfluenced(provenance: TurnProvenance): void {
  provenance.peerInfluenced = true;
}
