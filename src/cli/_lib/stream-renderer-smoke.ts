/**
 * AFK_SMOKE_TEXT effects for machine-status UI in the interactive REPL.
 *
 * Invariant (visual hierarchy): streamed prose, the model's own language, is
 * smoked per character by `StreamingMarkdownRenderer` (smoke-reveal.ts).
 * Persistent machine-status UI enters with the lightweight whole-element
 * fade from smoke-fade.ts: live tool rows (keyed by toolUseId) and the
 * `◆ thought for Xs` summary (held in its own overlay slot while it fades;
 * see thought-summary-hold.ts). Scrollback, input, footer, and the spinner
 * are untouched.
 *
 * Contract (flag off): `armSmokeEffects` returns null, so nothing is
 * registered, no fade is attached to the lane, and no timer can ever be
 * armed. The overlay and every commit are byte-identical to the smoke-off
 * build. Also null under reduced motion, matching the tool-lane flash gate.
 *
 * One `ElementFade` is shared by both surfaces, so at most one frame timer
 * runs however many rows and summaries are fading at once.
 *
 * @module cli/_lib/stream-renderer-smoke
 */

import { isSmokeTextEnabled } from '../smoke-reveal.js';
import { ElementFade } from '../smoke-fade.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { OverlayComposer } from './overlay-composer.js';
import {
  ThoughtSummaryHold,
  THOUGHT_SUMMARY_SLOT,
  type HoldCompositor,
} from './thought-summary-hold.js';

export { THOUGHT_SUMMARY_SLOT } from './thought-summary-hold.js';

export interface SmokeEffects {
  readonly thoughtHold: ThoughtSummaryHold;
  /** Commit any held summary, stop the frame driver, detach from the lane. */
  dispose(): void;
}

/**
 * Wire the machine-status fades into an armed TTY renderer. Returns null (and
 * touches nothing) when smoke is off or reduced motion is requested.
 *
 * @param deferFlush The renderer's mark-dirty + microtask-flush helper. Each
 *   fade frame marks both faded slots dirty; the composer coalesces them into
 *   one flush.
 */
export function armSmokeEffects(args: {
  compositor: HoldCompositor;
  overlayComposer: OverlayComposer;
  toolLane: ToolLane;
  reducedMotion: boolean;
  deferFlush: (slot: string) => void;
}): SmokeEffects | null {
  if (args.reducedMotion || !isSmokeTextEnabled()) return null;
  const { compositor, overlayComposer, toolLane, deferFlush } = args;
  const fade = new ElementFade(() => {
    deferFlush('tool-lane');
    deferFlush(THOUGHT_SUMMARY_SLOT);
  });
  const thoughtHold = new ThoughtSummaryHold(compositor, overlayComposer, fade);
  overlayComposer.register({ key: THOUGHT_SUMMARY_SLOT, render: () => thoughtHold.render() });
  toolLane.fade = fade;
  return {
    thoughtHold,
    dispose(): void {
      // Order: commit the held summary while the compositor is still armed,
      // THEN stop the frame driver (a late frame must not repaint after).
      thoughtHold.dispose();
      fade.dispose();
      if (toolLane.fade === fade) toolLane.fade = null;
    },
  };
}
