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
import { syntheticResult, type SourceState } from './stream-renderer-source.js';
import {
  childBannerEvent,
  countRunningChildren,
  deriveChildBanner,
  type ChildActivityTracker,
} from './child-activity-select.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import type { StreamingMarkdownRenderer } from '../markdown-stream.js';
import type { Writer } from '../slash/types.js';
import type { ProgressEvent } from '../../agent/types.js';
import { renderTtfbWaitingLine, checkTtfbAnnotation, type TtfbTickCtx } from './stream-renderer-ttfb.js';

const PAUSE_THRESHOLD_MS = 30_000;
const WAITING_LABEL_PREFIX = ' · waiting ';
const K = 375;

/**
 * Context for lifecycle methods — encapsulates the pieces needed to arm the
 * compositor and set up overlay slots. Extends {@link TtfbTickCtx} so the
 * TTFB elapsed-timer fields (ttfbStartedAt, ttfbDone, lastTtfbAnnotation) are
 * defined in one place (stream-renderer-ttfb.ts) and reused here without
 * duplication.
 */
export interface LifecycleContext extends TtfbTickCtx {
  compositor: TerminalCompositor | null;
  overlayComposer: OverlayComposer | null;
  stageTracker: ReturnType<typeof createStageTracker>;
  thinkingLane: ThinkingLane;
  toolLane: ToolLane;
  streamingMarkdownRef: { current: StreamingMarkdownRenderer | null };
  lastProgressByTask: Map<string, ProgressEvent>;
  thinkingMode: 'off' | 'summary' | 'live' | 'digest';
  out: Writer;
  sources: Map<string, SourceState>;
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
    /**
     * Live source map + sticky selector for the banner's child-activity
     * fallback. Optional so existing non-TTY callers and tests register slots
     * unchanged; when absent the banner keeps its pre-change behaviour of
     * leaving the detail slot blank during a foreground subagent dispatch.
     */
    sources?: ReadonlyMap<string, SourceState>;
    childActivity?: ChildActivityTracker;
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
    /**
     * Live TTFB state accessors. When `getTtfbStartedAt()` returns a number and
     * `isTtfbDone()` returns false, the progress-banner slot renders the elapsed
     * waiting line in place of an empty banner (no progress events yet). Cleared
     * by `notifyFirstContent()` on the StreamRenderer once the first content
     * chunk arrives. Optional so existing non-TTY callers and tests are
     * unchanged; when absent the waiting line is never shown.
     */
    getTtfbStartedAt?: () => number | undefined;
    isTtfbDone?: () => boolean;
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
      // Fallback: the model's clause is empty for the whole of a foreground
      // subagent dispatch (phase sealed at the agent tool_use_detail boundary),
      // so name the busiest child instead of letting the line go blank. This is
      // the production render path — setComposedOverlay carries the same
      // fallback for the direct-compositor path used by tests/non-TTY.
      const modelActivity = deriveProgressActivity(ctx.thinkingLane.peekPhase());
      // The child banner applies only when the model's own clause is empty —
      // i.e. exactly the foreground-dispatch case, where lastProgressByTask is
      // frozen at its pre-dispatch values. See deriveChildBanner for why the
      // stats must be re-scoped along with the clause.
      const childBanner = modelActivity ? undefined : deriveChildBanner(ctx);
      const activity = modelActivity ?? childBanner?.activity;
      const runningCount = countRunningChildren(ctx.sources);
      for (const progress of ctx.lastProgressByTask.values()) {
        const event = childBanner
          ? { ...progress, ...childBanner.stats, lastToolName: undefined }
          : progress;
        bannerLines.push(...formatProgressBanner(event, undefined, activity, stopping, runningCount));
      }
      // ESC soft-stop must give visible feedback even on a text-only turn that
      // never emitted a `progress` event (lastProgressByTask empty). Synthesize
      // a minimal banner so the `stopping…` state always paints; the synthetic
      // event carries no stats, so formatProgressBanner renders just the glyph +
      // description + stopping clause.
      //
      // Ordering constraint: this branch runs BEFORE the child fallback below.
      // Both fire only when the per-task loop produced nothing, and a stopping
      // turn must surface `stopping…` rather than a child clause — so soft-stop
      // claims the empty slot first and the child branch sees a non-empty
      // bannerLines.
      if (stopping && bannerLines.length === 0) {
        bannerLines.push(
          ...formatProgressBanner(
            { taskId: '__soft_stop__', description: 'Turn', totalTokens: 0, toolUses: 0, durationMs: 0 },
            undefined,
            undefined,
            true,
            runningCount,
          ),
        );
      }
      // A live child while the parent has reported no round yet: the per-task
      // loop above had nothing to iterate, so the clause and the child-scoped
      // stats would be dropped. See childBannerEvent for why lastProgressByTask
      // is empty for the whole of a FIRST-round foreground dispatch.
      if (childBanner && bannerLines.length === 0) {
        bannerLines.push(
          ...formatProgressBanner(
            childBannerEvent(childBanner.stats),
            undefined,
            activity,
            stopping,
            runningCount,
          ),
        );
      }
      // TTFB waiting line: no progress events yet and no content has arrived.
      // Delegates to renderTtfbWaitingLine (stream-renderer-ttfb.ts) which
      // returns '' when the timer is inactive, done, or inside the grace period.
      if (bannerLines.length === 0 && !stopping) {
        const waiting = renderTtfbWaitingLine(ctx.getTtfbStartedAt, ctx.isTtfbDone, palette);
        if (waiting) bannerLines.push(waiting);
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
 * Also delegates to `checkTtfbAnnotation` (stream-renderer-ttfb.ts) which
 * advances the TTFB waiting-line counter once per second while no content has
 * arrived yet (same 1 Hz change-detection pattern as the stall annotation).
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
        // Invariant: isError MUST be true. This row is a renderer-side give-up,
        // not a result. Nothing here touches the sub-agent's AbortController —
        // it may still be running, and often is: a forge qualify sub-agent has
        // been observed auto-settling here at ~90s and then failing for real
        // ~18 minutes later. Passing false makes doneGlyph() paint a green
        // success check on a row whose own label reads "[no-result — timed
        // out]", so a 20-minute failure renders as a 90-second success. The
        // glyph must agree with the label. If a real result arrives later,
        // finalizeSubagent overwrites this row, so a transient error mark
        // self-heals; a false success does not.
        ctx.toolLane.addResult(
          source.syntheticAgentToolUseId,
          syntheticResult('[no-result — timed out]', true),
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
  // Elapsed-counter invalidation: mark the tool-lane dirty whenever any
  // in-flight entry's displayed second has advanced. Silent commands (those
  // that emit no further events) never trigger a repaint otherwise, leaving
  // the elapsed counter frozen. checkElapsedDisplayNeedsUpdate() detects
  // second-boundary crossings using per-entry last-seen state, so the slot is
  // only dirtied at most once per second per in-flight entry — not on every
  // 80 ms tick. Runs unconditionally (does not gate on PAUSE_THRESHOLD_MS)
  // because the counter should tick from the moment grace expires (2 s), not
  // only once the stall detector kicks in (30 s).
  if (ctx.toolLane.checkElapsedDisplayNeedsUpdate()) {
    changed = true;
  }

  if (changed && ctx.isTTY && ctx.overlayComposer) {
    ctx.overlayComposer.markDirty('tool-lane');
    ctx.overlayComposer.flush();
  }

  // TTFB elapsed counter: delegates to checkTtfbAnnotation (stream-renderer-ttfb.ts)
  // which fires a progress-banner flush at most once per second while waiting for
  // the first content token. Mutates ctx.lastTtfbAnnotation in place; the caller
  // (stream-renderer.ts) writes back the updated annotation on every tick.
  checkTtfbAnnotation(ctx, now);

  return changed;
}
