/**
 * StreamRenderer lifecycle: arm(), overlay composition, and stall detection.
 *
 * Extracted from stream-renderer.ts to keep the core class under 350 lines.
 * Contains the OverlayComposer construction (CRITICAL: preserves the 5-slot
 * registration order exactly) and the stalled-entry checker.
 *
 * @module cli/_lib/stream-renderer-lifecycle
 */

import type { TerminalCompositor } from '../terminal-compositor.js';
import { ResizeBus } from '../terminal-size.js';
import { OverlayComposer } from './overlay-composer.js';
import { createStageTracker } from '../commands/interactive/loop-stage.js';
import { formatDuration } from '../format-utils.js';
import { formatThinkingParagraph } from '../commands/interactive/thinking-paragraph.js';
import { deriveProgressActivity, formatProgressBanner } from '../commands/interactive/progress-banner.js';
import { palette } from '../palette.js';
import { getTerminalWidth } from '../terminal-size.js';
import { isDebugEnabled } from '../../utils/debug.js';
import type { SourceState } from './stream-renderer-source.js';
import { syntheticResult } from './stream-renderer-source.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import type { StreamingMarkdownRenderer } from '../markdown-stream.js';
import type { Writer } from '../slash/types.js';
import type { ProgressEvent } from '../../agent/types.js';

const PAUSE_THRESHOLD_MS = 30_000;
const WAITING_LABEL_PREFIX = ' · waiting ';
const K = 375;

/**
 * Context for lifecycle methods — encapsulates the pieces needed to arm the
 * compositor and set up overlay slots.
 */
export interface LifecycleContext {
  compositor: TerminalCompositor | null;
  overlayComposer: OverlayComposer | null;
  stageTracker: ReturnType<typeof createStageTracker>;
  thinkingLane: ThinkingLane;
  toolLane: ToolLane;
  streamingMarkdownRef: { current: StreamingMarkdownRenderer | null };
  lastProgressByTask: Map<string, ProgressEvent>;
  thinkingMode: 'off' | 'summary' | 'live' | 'digest';
  out: Writer;
  isTTY: boolean;
  sources: Map<string, SourceState>;
  disposed: boolean;
  pauseTickInterval: ReturnType<typeof setInterval> | null;
  resizeUnsub: (() => void) | null;
}

/**
 * Construct and register the OverlayComposer with the five overlay slot types
 * in z-order. The slots read live state at flush time.
 *
 * CRITICAL PRESERVATION: The slot order (thinking-live, markdown-pending,
 * tool-lane, progress-banner, interrupt) must remain exactly as written here —
 * this is the corruption fix.
 *
 * Note: the `'stage-rail'` slot has been removed from the overlay. The stage
 * rail is now rendered as a reserved footer row via `LoopStageBar` (same
 * DECSTBM extra-row mechanism as `BackgroundStatusBar`), not as part of the
 * live overlay frame. The `stageTracker` field is kept in the context type for
 * the `LifecycleContext` interface but is no longer consumed here.
 */
export function registerOverlaySlots(
  overlayComposer: OverlayComposer,
  ctx: Readonly<Pick<LifecycleContext, 'stageTracker' | 'thinkingMode' | 'thinkingLane' | 'streamingMarkdownRef' | 'toolLane' | 'lastProgressByTask'>> & {
    /** Live interrupt state — true while a Ctrl+C interrupt is being processed. */
    getInterrupting: () => boolean;
    /**
     * Live soft-stop state — true once ESC has requested a soft-stop but the
     * turn has not finished tearing down. Reads the StreamRenderer's
     * `softStopping` flag (mirrors {@link getInterrupting}); drives the progress
     * banner's `stopping…` swap so ESC gives visible feedback on the next
     * repaint. See stream-renderer's `setSoftStopping`.
     */
    getSoftStopping: () => boolean;
  },
): void {
  // Register overlay slots (thinking-live, markdown-pending, tool-lane,
  // progress-banner, interrupt). The stage-rail slot has been promoted to a
  // reserved footer row via LoopStageBar and is no longer part of the overlay.
  overlayComposer.register({
    key: 'thinking-live',
    render: () => {
      // isActive() flips false once thinking is collapsed into the
      // "thought for Xs" summary committed above. The buffer is intentionally
      // retained afterward (inlineSummary reads it for subagent Done rows), so
      // gating on hasBufferedContent() alone would keep re-painting the
      // already-collapsed thinking into the idle overlay between turns.
      if (
        (ctx.thinkingMode !== 'live' && ctx.thinkingMode !== 'digest') ||
        !ctx.thinkingLane.isActive() ||
        !ctx.thinkingLane.hasBufferedContent()
      ) {
        return '';
      }
      // peekPhase() (not peek()): render only the CURRENT uncommitted phase so
      // the preview clears once a phase is collapsed into an inline "◆ thought
      // for Xs" line in scrollback, instead of re-streaming reasoning already
      // committed above. peekPhase() === '' after a seal → formatThinkingParagraph
      // returns '' → OverlayComposer drops the empty slot (no blank gap).
      const paragraph = formatThinkingParagraph(ctx.thinkingLane.peekPhase(), {
        cols: getTerminalWidth(),
      });
      return paragraph ?? '';
    },
  });

  overlayComposer.register({
    key: 'markdown-pending',
    render: () => {
      const markdown = ctx.streamingMarkdownRef.current;
      if (!markdown) return '';
      return markdown.renderPending();
    },
  });

  overlayComposer.register({
    key: 'tool-lane',
    render: () => {
      if (!ctx.toolLane.hasPending()) return '';
      return ctx.toolLane.getOverlay();
    },
  });

  overlayComposer.register({
    key: 'progress-banner',
    render: () => {
      const bannerLines: string[] = [];
      const stopping = ctx.getSoftStopping();
      // Grounded activity: the model's in-flight thinking clause (current
      // uncommitted phase only — peekPhase clears at each seal boundary, so
      // a stale clause never outlives the phase that produced it). Falls
      // back to the event's tool-derived summary inside formatProgressBanner.
      const activity = deriveProgressActivity(ctx.thinkingLane.peekPhase());
      for (const progress of ctx.lastProgressByTask.values()) {
        bannerLines.push(...formatProgressBanner(progress, undefined, activity, stopping));
      }
      // ESC soft-stop must give visible feedback even on a text-only turn that
      // never emitted a `progress` event (lastProgressByTask empty). Synthesize
      // a minimal banner so the `stopping…` state always paints; the synthetic
      // event carries no stats, so formatProgressBanner renders just the glyph +
      // description + stopping clause.
      if (stopping && bannerLines.length === 0) {
        bannerLines.push(
          ...formatProgressBanner(
            { taskId: '__soft_stop__', description: 'Turn', totalTokens: 0, toolUses: 0, durationMs: 0 },
            undefined,
            undefined,
            true,
          ),
        );
      }
      return bannerLines.length > 0 ? bannerLines.join('\n') : '';
    },
  });

  // Interrupt affordance — bottom-most slot (nearest the prompt). Active only
  // while a Ctrl+C interrupt is being processed mid-turn; renders '' otherwise
  // so it occupies no space in the composed frame.
  overlayComposer.register({
    key: 'interrupt',
    render: () => formatInterruptAffordance(ctx.getInterrupting()),
  });
}

/**
 * Render the live "interrupting…" overlay affordance, or '' when not
 * interrupting. Extracted as a pure function so the slot's contract is unit
 * testable without constructing the full lifecycle context.
 */
export function formatInterruptAffordance(interrupting: boolean): string {
  return interrupting
    ? '  ' + palette.warning('⚠ interrupting… (Ctrl+C again to exit)')
    : '';
}

/**
 * Set up the resize subscription for the OverlayComposer.
 * Re-derives the composed overlay at the new terminal width on window resize.
 *
 * Returns an unsubscriber function.
 */
export function subscribeToResize(
  overlayComposer: OverlayComposer,
  disposed: boolean,
): () => void {
  return ResizeBus.subscribe(() => {
    if (disposed || !overlayComposer) return;
    overlayComposer.invalidate();
    overlayComposer.flush();
  });
}

/**
 * Bounded stalled-entry lifecycle checker. Called every 80ms by the pause tick interval.
 *
 * Per-source state machine:
 *   - If done or errored: skip (no-op).
 *   - If elapsed > PAUSE_THRESHOLD_MS: increment stalledTicks, then update
 *     pause-annotation label (soft warning).
 *   - At stalledTicks === 2K (750 × 80ms = 60s): inject synthetic timed-out
 *     result and set source.done = true.
 *
 * Returns true if the overlay was changed and needs a flush.
 */
export function checkPauseAnnotations(ctx: LifecycleContext): boolean {
  if (ctx.disposed) return false;
  let changed = false;
  const now = Date.now();
  for (const [sourceId, source] of ctx.sources) {
    if (source.done || source.errored || !source.syntheticAgentToolUseId) continue;
    const elapsed = now - source.lastEventAt;
    if (elapsed > PAUSE_THRESHOLD_MS) {
      source.stalledTicks += 1;
      // Use >= not === — if the counter ever overshoots 2K (e.g. from a
      // future refactor that increments in more than one place), the cutoff
      // must still fire. Strict equality would silently never trigger.
      if (source.stalledTicks >= K * 2) {
        // Hard cutoff at 2K ticks (60s): auto-settle with synthetic timed-out result.
        if (isDebugEnabled()) {
          process.stderr.write(
            `[stream-renderer] auto_settle_timeout ${JSON.stringify({ sourceId, elapsedMs: elapsed, syntheticAgentToolUseId: source.syntheticAgentToolUseId })}\n`,
          );
        }
        ctx.toolLane.addResult(
          source.syntheticAgentToolUseId,
          syntheticResult('[no-result — timed out]', false),
        );
        source.done = true;
        changed = true;
      } else {
        // Soft warning (any stalled tick < 2K): keep annotation fresh.
        const label = source.agentType ?? sourceId;
        const annotation = WAITING_LABEL_PREFIX + formatDuration(elapsed);
        if (source.pauseAnnotation !== annotation) {
          source.pauseAnnotation = annotation;
          ctx.toolLane.addStartWithAgentContext(
            source.syntheticAgentToolUseId, 'Agent', `(${label})${annotation}`, undefined,
          );
          changed = true;
        }
      }
    }
  }
  if (changed && ctx.isTTY && ctx.overlayComposer) {
    ctx.overlayComposer.markDirty('tool-lane');
    ctx.overlayComposer.flush();
  }
  return changed;
}
