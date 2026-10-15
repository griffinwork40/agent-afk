/**
 * Telegram /good and /bad command handlers — record explicit operator feedback
 * on the current session's VerifiedOutcome.
 *
 * Mirrors the REPL /good and /bad slash commands but operates on the Telegram
 * bot's active session for the chat that sent the command. Design:
 * docs/proposals/verified-outcome.md § "Explicit feedback".
 *
 * Thumbs reactions (👍/👎 via Telegram reaction updates) are a follow-up:
 * Telegraf v4's `bot.reaction()` API exists but reaction updates require
 * allowUpdates=['message_reaction'] in polling config, which is not wired in
 * bot.ts today. Adding it cleanly requires changes to the polling setup and a
 * session-id lookup from the reacted-to message. Deferred to a later node.
 */

import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { upsertVotes } from '../../agent/outcomes/store.js';
import { errorMessage } from '../../utils/errors.js';
import type { SessionManager } from '../session-manager.js';
import { routeFromCtx } from '../route.js';

type LogFn = (...args: unknown[]) => void;

// ---------------------------------------------------------------------------
// Shared logic
// ---------------------------------------------------------------------------

async function handleFeedback(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
  polarity: 'good' | 'bad',
): Promise<void> {
  const route = routeFromCtx(ctx);
  if (!route) {
    await ctx.reply('Could not identify chat.');
    return;
  }

  const sessionId = sessionManager.getSessionId(route);
  if (!sessionId) {
    await ctx.reply(
      'Session id not yet assigned — no model turn has completed in this chat. ' +
        'Send a message first, then rate.',
    );
    return;
  }

  const text = (ctx.message as Message.TextMessage | undefined)?.text ?? '';
  const note = text.split(/\s+/).slice(1).join(' ').trim() || 'operator';

  const vote: 1 | -1 = polarity === 'good' ? 1 : -1;
  const label = polarity === 'good' ? 'succeeded' : 'failed';
  const icon = polarity === 'good' ? '👍' : '👎';

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
    await ctx.reply(`${icon} Recorded: ${label} (session ${sessionId})`);
  } catch (err) {
    log('Feedback record error:', err);
    await ctx.reply(`Failed to record feedback: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export async function handleGood(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
): Promise<void> {
  return handleFeedback(ctx, sessionManager, log, 'good');
}

export async function handleBad(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
): Promise<void> {
  return handleFeedback(ctx, sessionManager, log, 'bad');
}
