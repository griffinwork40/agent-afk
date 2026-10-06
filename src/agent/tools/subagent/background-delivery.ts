/**
 * How a background subagent's result reaches the agent that dispatched it, and
 * the model-facing sentence that says so.
 *
 * Invariant: the sentence must be TRUE for the caller that receives it. The
 * three modes map to three different runtime facts:
 *
 *   - `auto-wake`: a depth-0 executor whose surface wakes an idle prompt when
 *     a result lands (the TTY REPL: BgResultNotifier.onInjectable →
 *     tryAutoResume in cli/commands/interactive/loop-iteration.ts). The right
 *     move is to END THE TURN; holding it open to poll is pure waste.
 *   - `next-message`: a depth-0 executor on a surface that only buffers the
 *     result for the next inbound user turn (Telegram, non-TTY REPL, web,
 *     AFK_BG_AUTO_DELIVER=0). No wake, so promising one would be false.
 *   - `root-session`: a depth ≥ 1 executor (a subagent dispatching its own
 *     background job). The BackgroundAgentRegistry is shared by reference down
 *     the tree and BgResultNotifier does not filter by parent, so the result
 *     is injected into the TOP-LEVEL session, never into this child. Telling a
 *     child "it will be delivered into this context" strands its work.
 *
 * History: session 4b702f8c (2026-10-06) spent ~42 min of one turn polling a
 * `wait_for` proxy, then tried a fake-sleep command the risk gate blocked,
 * because the only wording ever shown was "with the next user message".
 *
 * @module agent/tools/subagent/background-delivery
 */

import type { BackgroundAgentRegistry } from '../../background-registry.js';

export type BackgroundDelivery = 'auto-wake' | 'next-message' | 'root-session';

/** The executor-context slice needed to decide delivery. */
export interface BackgroundDeliveryContext {
  depth: number;
  backgroundRegistry?: BackgroundAgentRegistry;
  backgroundAutoWake?: () => boolean;
}

/**
 * Resolve the delivery mode at dispatch time. The auto-wake probe is read
 * live (not cached at wiring) so an env toggle mid-session is honoured.
 */
export function resolveBackgroundDelivery(ctx: BackgroundDeliveryContext): BackgroundDelivery {
  if (ctx.depth > 0) return 'root-session';
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
