/**
 * Compact-command handler extracted from MessageHandler.
 *
 * Invariant: all state mutations go through explicit parameters -- never closed
 * over from the enclosing class. The class delegates via processCompactDirectImpl
 * so the public surface of MessageHandler is unchanged.
 *
 * @module telegram/handlers/message.compact-handler
 */

import type { Context } from 'telegraf';
import { formatError, formatCompact, formatCompactNoop, formatMicrocompact, escapeHtml } from '../formatter.js';
import { withTypingIndicator } from '../typing-indicator.js';
import { HookBlockedError } from '../../utils/errors.js';
import { type TelegramRoute, routeKey } from '../route.js';
import type { SessionManager } from '../session-manager.js';

type LogFn = (...args: unknown[]) => void;

/** Subset of MessageHandler state needed by processCompactDirectImpl. */
export interface CompactHandlerContext {
  sessionManager: SessionManager;
  log: LogFn;
  reserveClaim(key: string): void;
  releaseClaim(key: string): void;
  enqueueCompact(route: TelegramRoute, ctx: Context): void;
  drainQueue(route: TelegramRoute): Promise<void>;
}

/**
 * Process compact command at drain time (session is idle when called).
 * Fires drainQueue after completion so any messages queued during compaction
 * are processed.
 *
 * Mirrors the busy-recovery contract in processOne: drainQueue runs from a
 * `finally` after a turn completes, but a new turn can begin in the window
 * between drain-start and the session.compact() call below (TOCTOU). When that
 * happens compact() returns reason 'session-busy' (it does not throw -- see
 * agent-session.ts compact()). Re-enqueue the compact in that case so it
 * actually runs once the session is idle, instead of surfacing the misleading
 * "Nothing to compact (session-busy)" no-op and dropping the request.
 */
export async function processCompactDirectImpl(
  route: TelegramRoute,
  ctx: Context,
  hc: CompactHandlerContext,
): Promise<void> {
  const key = routeKey(route);
  // Reserve a slot so any handle() arriving while compact is in flight sees the
  // chat as claimed and enqueues instead of double-entering. Mirrors the
  // reserveClaim/releaseClaim pattern in processOne. Paired 1:1 with the
  // releaseClaim in the finally.
  hc.reserveClaim(key);
  // See processOne: when we re-enqueue because the session is busy, the active
  // turn's own finally will drain the item we pushed. Draining here too would
  // shift that item and re-enter immediately -> busy-spin cascade.
  let reEnqueued = false;
  try {
    const session = await hc.sessionManager.getSession(route);
    const hookRegistry = session.hookRegistry;
    // Keep the "typing..." indicator alive across the PreCompact hook and the
    // model-call compaction, which can outlast the ~5s one-shot expiry.
    // Invariant: fire PreCompact before compaction. block -> skip, not error.
    const result = await withTypingIndicator(ctx, async () => {
      if (hookRegistry) {
        await hookRegistry.dispatch({
          event: 'PreCompact',
          sessionId: session.sessionId,
          trigger: 'manual',
        });
      }
      return session.compact();
    });
    if (result.reason === 'session-busy') {
      // Session became busy between drain-start and our compact() call (TOCTOU).
      // Re-enqueue so the compact isn't silently dropped with a confusing no-op.
      hc.enqueueCompact(route, ctx);
      reEnqueued = true;
      return;
    }
    if (result.reason === 'microcompacted' && result.microcompaction) {
      // Success-ish deterministic outcome: no messages removed, but large
      // tool_result payloads were cleared in place. Render the reclaimed win.
      await ctx.reply(formatMicrocompact(result.microcompaction));
    } else if (!result.compacted) {
      await ctx.reply(formatCompactNoop(result.reason ?? 'unknown'));
    } else {
      await ctx.reply(formatCompact({
        before: result.messagesBefore,
        after: result.messagesAfter,
        ...(result.tokensSavedEstimate !== undefined
          ? { tokensSavedEstimate: result.tokensSavedEstimate }
          : {}),
      }));
    }
  } catch (error) {
    if (error instanceof HookBlockedError) {
      await ctx.reply(`Compaction skipped: ${escapeHtml(error.reason ?? 'blocked by hook')}`);
    } else {
      hc.log('Compact error (queued):', error);
      await ctx.reply(formatError(error as Error));
    }
  } finally {
    // Order matters (mirrors processOne): fire drainQueue FIRST so the drained
    // turn's own reserveClaim runs synchronously before we drop this slot.
    // Only drain when we did NOT re-enqueue -- the active turn's finally will
    // drain the re-enqueued compact; draining here too causes a cascade.
    if (!reEnqueued) {
      hc.drainQueue(route).catch(err => hc.log('Drain error:', err));
    }
    hc.releaseClaim(key);
  }
}
