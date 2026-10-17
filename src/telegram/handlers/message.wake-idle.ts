/**
 * Idle-session wake implementation for `MessageHandler.wakeIdleSession`.
 *
 * Extracted from `message.ts` to keep that file within the 350-code-line
 * ceiling. Mirrors the REPL's `tryAutoResume` path in `loop-iteration.ts`:
 * synthesises a silent `[auto-resume]` turn when a background subagent result
 * has settled on an idle Telegram session so the model processes the result
 * immediately rather than waiting for the next user message.
 *
 * @module telegram/handlers/message.wake-idle
 */

import type { Context } from 'telegraf';
import type { IAgentSession } from '../../agent/types.js';
import { type TelegramRoute, routeKey } from '../route.js';
import { autoResumeDirective } from '../../cli/commands/interactive/loop-iteration.injections.js';

/**
 * Minimal deps slice needed by {@link wakeIdleSessionImpl}.
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
  const syntheticCtx = {
    chat: { id: route.chatId, type: 'private' as const },
    message: undefined,
    botInfo: undefined,
    react: () => Promise.resolve(),
    reply: () => Promise.resolve({}),
    sendChatAction: () => Promise.resolve(true),
  } as unknown as Context;
  // Fire-and-forget: processOne takes its own reserveClaim synchronously at
  // entry, so there is no window between this call and the slot being held.
  deps.processOne(route, syntheticCtx, autoResumeDirective(true)).catch(
    (err: unknown) => deps.log('[wakeIdleSession] error:', err),
  );
}
