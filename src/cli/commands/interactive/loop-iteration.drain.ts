/**
 * Per-turn notification drain — top-of-loop human-visible lines for
 * completed shell jobs, settled background subagents, and context-pane
 * changes. Extracted from `runInputLoop` so that new drain sources never
 * grow that grandfathered function.
 *
 * @module cli/commands/interactive/loop-iteration.drain
 */

import { drainLoopNotifications as drainJobNotifications } from './loop-notifications.js';
import type { InteractiveCtx } from './shared.js';
import type { FooterSubsystems } from './footer-subsystems.js';

/**
 * Drain and render all pending human-visible notifications: shell-job
 * completions, background-subagent completions, and context-pane changes.
 *
 * Shell-job notifications are one-line summaries of backgrounded `!&cmd`
 * processes. Background-subagent notifications are one-line summaries of
 * settled `agent`-tool jobs. Both are summary-only — the injected model
 * context arrives separately through `prependTurnInjections`.
 *
 * Context-pane changes are rendered as a block above the prompt when the
 * pane content has changed since the last iteration.
 *
 * Must be called once per loop iteration BEFORE the readLine / seed-buffer
 * fast-path so all notifications appear before the next prompt.
 */
export function drainLoopNotifications(ctx: InteractiveCtx, footer: FooterSubsystems): void {
  const { shellPassthrough, bgResultNotifier, contextPane } = footer;

  drainJobNotifications(ctx, shellPassthrough, bgResultNotifier);

  const paneLines = contextPane.renderIfChanged(ctx.stats.sessionId);
  if (paneLines.length > 0) {
    for (const l of paneLines) ctx.replRenderer.writeLine(l);
    ctx.replRenderer.writeLine('');
  }
}
