/**
 * How a background subagent's result reaches the agent that dispatched it, and
 * the model-facing sentence that says so.
 *
 * Invariant: the sentence must be TRUE for the caller that receives it. The
 * four modes map to four different runtime facts:
 *
 *   - `auto-wake`: a depth-0 executor whose surface wakes an idle prompt when
 *     a result lands (the TTY REPL: BgResultNotifier.onInjectable →
 *     tryAutoResume in cli/commands/interactive/loop-iteration.ts). The right
 *     move is to END THE TURN; holding it open to poll is pure waste.
 *   - `next-message`: a depth-0 executor on a surface that buffers the result
 *     for the next inbound user turn (Telegram, non-TTY REPL, web) but does
 *     NOT wake an idle prompt. No wake promise, but delivery IS automatic.
 *   - `manual-join`: a depth-0 executor with AFK_BG_AUTO_DELIVER=0. The
 *     BgResultNotifier.onSettled guard returns early without buffering, so
 *     the result is NEVER injected automatically. The agent must use
 *     /bgsub:join or get_background_job_health to retrieve it.
 *   - `root-session`: a depth ≥ 1 executor (a subagent dispatching its own
 *     background job). The BackgroundAgentRegistry is shared by reference down
 *     the tree and BgResultNotifier does not filter by parent, so the result
 *     is injected into the TOP-LEVEL session, never into this child. Telling a
 *     child "it will be delivered into this context" strands its work.
 *
 * History: session 4b702f8c (2026-10-06) spent ~42 min of one turn polling a
 * `wait_for` proxy, then tried a fake-sleep command the risk gate blocked,
 * because the only wording ever shown was "with the next user message".
 * AFK_BG_AUTO_DELIVER=0 was previously misclassified as `next-message`, which
 * promises automatic delivery that the disabled notifier never performs.
 *
 * @module agent/tools/subagent/background-delivery
 */

import type { BackgroundAgentRegistry } from '../../background-registry.js';

export type BackgroundDelivery = 'auto-wake' | 'next-message' | 'manual-join' | 'root-session';

/** The executor-context slice needed to decide delivery. */
export interface BackgroundDeliveryContext {
  depth: number;
  backgroundRegistry?: BackgroundAgentRegistry;
  /** Returns true when the surface will auto-wake an idle prompt on result. */
  backgroundAutoWake?: () => boolean;
  /**
   * Returns true when BgResultNotifier will buffer the result for the next
   * user message (auto-deliver is enabled). When false (AFK_BG_AUTO_DELIVER=0),
   * no injection occurs at all — the mode becomes `manual-join`.
   */
  backgroundAutoDeliver?: () => boolean;
}

/**
 * Resolve the delivery mode at dispatch time. All probes are read live (not
 * cached at wiring) so env toggles mid-session are honoured.
 *
 * Invariant: `auto-wake` ⊆ `next-message` ⊆ `manual-join` (auto-wake implies
 * deliver; next-message implies deliver but no wake; manual-join means neither).
 */
export function resolveBackgroundDelivery(ctx: BackgroundDeliveryContext): BackgroundDelivery {
  if (ctx.depth > 0) return 'root-session';
  // AFK_BG_AUTO_DELIVER=0 disables BgResultNotifier entirely — no buffering,
  // no injection. Must be checked before the wake probe so we don't promise
  // auto-delivery that will never happen.
  if (ctx.backgroundAutoDeliver?.() === false) return 'manual-join';
  return ctx.backgroundAutoWake?.() === true ? 'auto-wake' : 'next-message';
}

/**
 * Registry plus delivery mode, spread into the background / promotion branch
 * args so the executor call sites carry both with one line.
 */
export function backgroundTarget(ctx: BackgroundDeliveryContext): {
  registry: BackgroundAgentRegistry | undefined;
  delivery: BackgroundDelivery;
} {
  return { registry: ctx.backgroundRegistry, delivery: resolveBackgroundDelivery(ctx) };
}

const NO_POLL = 'Do not poll for it (no wait_for proxies, sleep loops, or repeated status checks).';

/** Model-facing sentence describing how (and whether) the result arrives. */
export function backgroundDeliveryNote(delivery: BackgroundDelivery | undefined, jobId: string): string {
  switch (delivery) {
    case 'auto-wake':
      return (
        `${NO_POLL} End your turn: this idle session is woken automatically and the ` +
        `result is injected as a <background-subagent-result> block when the job finishes ` +
        `(if the user is mid-typing, it rides along with their next message instead).`
      );
    case 'manual-join':
      return (
        `Automatic delivery is disabled (AFK_BG_AUTO_DELIVER=0). The result will NOT be ` +
        `injected automatically. ${NO_POLL} To retrieve the result, use ` +
        `/bgsub:join ${jobId} or get_background_job_health after ending your turn.`
      );
    case 'root-session':
      return (
        `Its result is delivered to the top-level session, NOT to this context, so you will ` +
        `not receive it here. ${NO_POLL} If you need the result to continue, cancel it with ` +
        `cancel_background_job ${jobId} and dispatch again with mode="foreground".`
      );
    default:
      return (
        `Its result will be delivered into this context automatically with the next user ` +
        `message once it finishes. ${NO_POLL}`
      );
  }
}
