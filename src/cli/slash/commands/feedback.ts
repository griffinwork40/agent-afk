/**
 * /good [note] and /bad [note] — record explicit operator feedback on the
 * current session's outcome.
 *
 * Writes an `explicit_feedback` vote (strong, +1 or -1, evidence = note or
 * 'operator') into the session's VerifiedOutcome record via upsertVotes().
 * This is the strongest labeling-function signal and overrides the combiner:
 * /good → succeeded (confidence 1.0, settled), /bad → failed.
 *
 * If the session id is not yet known (before the first model turn assigns
 * one), prints a clear message instead of guessing.
 *
 * Never prompted for automatically. Design: docs/proposals/verified-outcome.md
 * § "Explicit feedback".
 */

import { palette } from '../../palette.js';
import { upsertVotes } from '../../../agent/outcomes/store.js';
import { errorMessage } from '../../../utils/errors.js';
import type { SlashCommand } from '../types.js';

// ---------------------------------------------------------------------------
// Shared logic
// ---------------------------------------------------------------------------

async function handleFeedback(
  ctx: import('../types.js').SlashContext,
  args: string,
  polarity: 'good' | 'bad',
): Promise<import('../types.js').SlashResult> {
  const sessionId = ctx.stats.sessionId;
  if (!sessionId) {
    ctx.out.warn(
      'Session id not yet assigned (no model turn has completed). ' +
        'Try again after the first reply.',
    );
    return 'continue';
  }

  const note = args.trim() || 'operator';
  const vote: 1 | -1 = polarity === 'good' ? 1 : -1;
  const label = polarity === 'good' ? 'succeeded' : 'failed';

  try {
    upsertVotes(sessionId, [
      {
        lf: 'explicit_feedback',
        vote,
        strength: 'strong',
        evidence: note,
        observed_at: new Date().toISOString(),
      },
    ]);
    const icon = polarity === 'good' ? '👍' : '👎';
    ctx.out.success(
      `${icon} ` +
        palette.success(`Recorded: ${label}`) +
        palette.dim(`  session ${sessionId}`),
    );
  } catch (err) {
    ctx.out.error(`Failed to record feedback: ${errorMessage(err)}`);
  }

  return 'continue';
}

// ---------------------------------------------------------------------------
// /good
// ---------------------------------------------------------------------------

export const goodCmd: SlashCommand = {
  name: '/good',
  usage: '/good [note]',
  hint: 'Rate this session as successful. Adds a strong explicit_feedback vote that overrides the combiner and settles the outcome immediately.',
  summary: 'Mark this session as succeeded (explicit outcome feedback)',
  async handler(ctx, args): Promise<import('../types.js').SlashResult> {
    return handleFeedback(ctx, args, 'good');
  },
};

// ---------------------------------------------------------------------------
// /bad
// ---------------------------------------------------------------------------

export const badCmd: SlashCommand = {
  name: '/bad',
  usage: '/bad [note]',
  hint: 'Rate this session as failed. Adds a strong explicit_feedback vote that overrides the combiner and settles the outcome immediately.',
  summary: 'Mark this session as failed (explicit outcome feedback)',
  async handler(ctx, args): Promise<import('../types.js').SlashResult> {
    return handleFeedback(ctx, args, 'bad');
  },
};
