/**
 * Idle-session wake implementation for `MessageHandler.wakeIdleSession`.
 *
 * Extracted from `message.ts` to keep that file within the 350-code-line
 * ceiling. Mirrors the REPL's `tryAutoResume` path in `loop-iteration.ts`:
 * synthesises a silent `[auto-resume]` turn when a background subagent result
 * has settled on an idle Telegram session so the model processes the result
 * immediately rather than waiting for the next user message.
 *
 * **Post-turn re-check** (#3974 medium fix): if `onInjectable` fires while a
 * turn is in flight (claim count > 0), the initial `wakeIdleSessionImpl` call
 * returns early. `processOne`'s finally calls `postTurnWake` after
 * `releaseClaim` to re-check for pending injections — mirroring the REPL's
 * `surface.onAwaitingInput = tryAutoResume` path.
 *
 * **Synthetic-turn error surfacing** (#3974 low fix): when a `bot` handle is
 * present in deps and a chat-scoped error occurs on a synthetic turn (where the
 * Context `reply` is a no-op), the error is forwarded via
 * `bot.telegram.sendMessage` so the operator is notified rather than the reply
 * being silently swallowed.
 *
 * @module telegram/handlers/message.wake-idle
 */

import type { Context } from 'telegraf';
import type { Telegraf } from 'telegraf';
import type { IAgentSession } from '../../agent/types.js';
import { type TelegramRoute, routeKey } from '../route.js';
import { autoResumeDirective } from '../../cli/commands/interactive/loop-iteration.injections.js';
import { hasBgInjections } from '../bg-injection.js';

/**
 * Minimal deps slice needed by {@link wakeIdleSessionImpl} and
 * {@link postTurnWake}.
 * `MessageHandler` satisfies this interface structurally; private members are
 * accessible because the cast happens inside `wakeIdleSession` (same file),
 * not across the module boundary. Callers outside `MessageHandler` must build
 * the object explicitly.
 */
export interface WakeIdleDeps {
  isClaimed(key: string): boolean;
  sessionManager: { getSessionIfExists(route: TelegramRoute): IAgentSession | undefined };
  messageQueues: Map<string, unknown[]>;
  processOne(route: TelegramRoute, ctx: Context, content: string): Promise<void>;
  log(...args: unknown[]): void;
  /**
   * Optional Telegraf bot instance. When present, errors on synthetic turns
   * are forwarded to the real chat via `bot.telegram.sendMessage` rather than
   * being silently swallowed by the no-op Context `reply` (#3974 low).
   */
  bot?: Telegraf;
}

/**
 * Synthesise a silent auto-resume turn for an idle session when a background
 * subagent result has settled. Called from `MessageHandler.wakeIdleSession`.
 *
 * Guards (all checked synchronously before the first `await`):
 * - **Claimed slot**: if a turn is in flight (`isClaimed`), returns immediately.
 *   The claim count stays > 0 for the duration of the turn (including drain
 *   hand-off), so a woken turn that dispatches another background job will see
 *   itself claimed when `onInjectable` fires again — bounding the chain to one
 *   pending wake per turn boundary, equivalent to the REPL's
 *   `MAX_AUTO_RESUMES_PER_TURN` circuit breaker.
 * - **Busy session**: `session.state !== 'idle'` catches the window where the
 *   claim count is 0 but a user message just grabbed the session (TOCTOU).
 * - **Non-empty queue**: if a real user message is already queued, let it carry
 *   the bg-injection naturally — no synthetic turn is needed.
 * - **No pending injections**: if the bg-injection buffer was already drained
 *   (e.g. by a concurrent turn's drainBgInjections call), skip the synthetic
 *   turn to avoid a no-op auto-resume.
 */
export function wakeIdleSessionImpl(route: TelegramRoute, deps: WakeIdleDeps): void {
  const key = routeKey(route);
  if (deps.isClaimed(key)) return;
  // Snapshot the session synchronously; if none exists for this route there is
  // nothing to wake — early-return so we never create a brand-new session just
  // to carry a synthetic auto-resume turn.
  const existing = deps.sessionManager.getSessionIfExists(route);
  if (!existing) return;
  if (existing.state !== 'idle') return;
  // A queued real message will carry the injection — no synthetic turn needed.
  const q = deps.messageQueues.get(key);
  if (q && q.length > 0) return;
  // Synthesise a minimal Context: no message_id, no reaction, no reply.
  // Error replies on synthetic turns are forwarded to the real chat via
  // bot.telegram.sendMessage when a bot handle is present (#3974 low).
  const { chatId } = route;
  const bot = deps.bot;
  const syntheticCtx = {
    chat: { id: chatId, type: 'private' as const },
    message: undefined,
    botInfo: undefined,
    react: () => Promise.resolve(),
    reply: (text: string) => {
      if (bot) {
        return bot.telegram.sendMessage(chatId, text).catch((e: unknown) => {
          deps.log('[wakeIdleSession] synthetic-reply forwarding failed:', e);
          return {} as import('telegraf/types').Message.TextMessage;
        });
      }
      deps.log('[wakeIdleSession] synthetic-turn reply (no bot handle):', text);
      return Promise.resolve({} as import('telegraf/types').Message.TextMessage);
    },
    sendChatAction: () => Promise.resolve(true),
  } as unknown as Context;
  // Fire-and-forget: processOne takes its own reserveClaim synchronously at
  // entry, so there is no window between this call and the slot being held.
  deps.processOne(route, syntheticCtx, autoResumeDirective(true)).catch(
    (err: unknown) => deps.log('[wakeIdleSession] error:', err),
  );
}

/**
 * Post-turn re-check for pending bg injections (#3974 medium fix).
 *
 * Called from `processOne`'s finally block AFTER `releaseClaim` drops the
 * count to zero. Mirrors the REPL's `surface.onAwaitingInput = tryAutoResume`
 * path: when `onInjectable` fires while a turn is claimed the initial
 * `wakeIdleSessionImpl` call is a no-op, so without this re-check the settled
 * result would wait for the next user message.
 *
 * Guards: skipped when the bg-injection buffer is empty (the completed turn
 * already drained everything — no point in firing a no-op synthetic turn),
 * when `isClaimed` is still > 0 (a drain-hand-off is in flight), when no
 * session exists, when the session is not idle, or when messages are queued
 * (they carry the injection naturally).
 */
export function postTurnWake(route: TelegramRoute, deps: WakeIdleDeps): void {
  const key = routeKey(route);
  // Skip when nothing is buffered — the completed turn already drained all
  // injections, so a synthetic turn would carry no payload.
  if (!hasBgInjections(key)) return;
  // Re-use the full guard logic — wakeIdleSessionImpl checks isClaimed first,
  // which covers the drain-hand-off window where releaseClaim has run but the
  // drained turn's reserveClaim is already in effect (count > 0).
  wakeIdleSessionImpl(route, deps);
}
