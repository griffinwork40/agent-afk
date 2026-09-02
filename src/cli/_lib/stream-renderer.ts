/**
 * StreamRenderer — shared rendering core for OutputEvent streams that may
 * mix one orchestrator source with N concurrent subagent sources.
 *
 * Owns the rendering trio (TerminalCompositor + ToolLane + StreamingMarkdownRenderer
 * + ThinkingLane) used by the main interactive turn handler, and exposes a
 * `process(event, meta?)` API that consumes any source's `OutputEvent` stream.
 *
 * One rule, no modes: events render under their source.
 *
 * - The orchestrator source (no `meta.subagentId`, keyed `__main__`) renders
 *   at root: streaming markdown for content, ToolLane for tool calls, optional
 *   thinking summary on done. Mirrors a normal interactive turn.
 *
 * - Each subagent source (any `meta.subagentId`) gets a synthetic
 *   `Agent(<label>)` ToolLane entry on its very first event. Subsequent
 *   tool_use / tool_result chunks from that subagent nest under the synthetic
 *   parent. Content chunks render as a {@link TextEntry} child of the synthetic
 *   parent ("last block wins": when a `tool_use_detail` interrupts the active
 *   text, the next content delta replaces the prior text child entirely).
 *
 * The orchestrator and subagents never share rendering state — they target
 * different ToolLane regions (root vs nested) and only the orchestrator
 * touches the streaming markdown renderer.
 *
 * @module cli/_lib/stream-renderer
 */

import type { OutputEvent, SubagentProgressMeta, ProgressEvent } from '../../agent/types.js';
import type { PreviewDiffRef } from '../../agent/tools/hooks/edit-preview-hook.js';
import type { Message } from '../../agent/types/message-types.js';
import type { Writer } from '../slash/types.js';
import { TerminalCompositor } from '../terminal-compositor.js';
import { isPlainOutputRequested } from '../../config/env.js';
import type { IHistoryRing } from '../input/types.js';
import type { AutocompleteState } from '../input/autocomplete-state.js';
import { colorizeInputBuffer, type SlashRegistryView } from '../input-highlight.js';
import { createSlashRegistryView } from '../slash/registry.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import { type SourceState } from './stream-renderer-source.js';
import { ChildActivityTracker } from './child-activity-select.js';
import { InFlightToolTracker } from '../input/work-derived-verb.js';
import { type OrchestratorCtx } from './stream-renderer-orchestrator.js';
import { CommitCoordinator } from './commit-coordinator.js';
import { OverlayComposer } from './overlay-composer.js';
import { createStageTracker, type StageTrackerState } from '../commands/interactive/loop-stage.js';
import { detectCaptureMode, detectReducedMotion, detectGoblinSpinner } from './capture-mode.js';
import { makeDedupingLineWriter } from './dedup-line-writer.js';
import { registerOverlaySlots, checkPauseAnnotations, subscribeToResize } from './stream-renderer-lifecycle.js';
import { checkProgressBannerStaleness } from './stream-renderer-dead-zone.js';
import { makeOrchestratorCtx } from './stream-renderer-contexts.js';
import { processEvent, type ProcessCtx } from './stream-renderer-process.js';
import { disposeRenderer, type DisposeCtx } from './stream-renderer-dispose.js';
import { applyFirstContent } from './stream-renderer-ttfb.js';
import { type SubagentStatusBarSpec } from '../render.js';

export type { StreamRendererOptions } from './stream-renderer-options.js';
import type { StreamRendererOptions } from './stream-renderer-options.js';

/**
 * Stream renderer. Construct once per skill invocation; call `sink` (or
 * `process`) for each OutputEvent; call `dispose()` in `finally`.
 */
export class StreamRenderer {
  private readonly out: Writer;
  private readonly thinkingMode: 'off' | 'summary' | 'live' | 'digest';
  private readonly isTTY: boolean;
  private readonly captureMode: boolean;
  private readonly reducedMotion: boolean;
  private readonly onCancel: (() => void) | undefined;
  private readonly onBackground: (() => void) | undefined;
  private readonly activeSkillName: string | undefined;
  private readonly history: IHistoryRing | undefined;
  private readonly autocompleteState: AutocompleteState | undefined;
  private readonly promptText: string | undefined;
  private readonly scrollRegion: { withFullScrollRegion<T>(fn: () => T): T; getExtraRows(): number } | undefined;
  private readonly onStageChange:
    | ((
        stage: import('../commands/interactive/loop-stage.js').LoopStage,
        signals?: import('../commands/interactive/loop-stage.js').StageSignals,
      ) => void)
    | undefined;
  /**
   * True when this renderer constructed its own compositor in {@link arm};
   * false when a compositor was borrowed via {@link StreamRendererOptions.compositor}.
   * Controls dispose lifecycle: owned compositors are disarmed and nulled;
   * borrowed compositors are reset to idle mode but left alive.
   */
  private ownsCompositor = true;
  /**
   * Pre-arm reference to a borrowed compositor (when provided). Captured in
   * the ctor so {@link arm} can move it into {@link compositor} without
   * re-reading options. Cleared in {@link dispose} after the borrow ends.
   */
  private borrowedCompositor: TerminalCompositor | null = null;

  /**
   * Owner's onCancel captured at borrow time; restored in dispose so
   * between-turns Ctrl+C continues working after the skill exits.
   * Only meaningful when ownsCompositor === false.
   */
  private priorOnCancel: (() => void) | undefined = undefined;

  /** Live interrupt state — flipped by {@link setInterrupting} on Ctrl+C. */
  private interrupting = false;

  /** Live soft-stop state — flipped by {@link setSoftStopping} on ESC. */
  private softStopping = false;

  /**
   * Single ordering authority for all scrollback writes during this turn.
   * Constructed fresh per-StreamRenderer-instance (= per-turn). Drains via
   * `dispose()` at turn end. See commit-coordinator.ts for drain order.
   */
  private readonly coordinator: CommitCoordinator = new CommitCoordinator();

  private compositor: TerminalCompositor | null = null;
  private overlayComposer: OverlayComposer | null = null;
  private streamingMarkdownRef: { current: StreamingMarkdownRenderer | null } = { current: null };
  private toolLane: ToolLane = new ToolLane();
  private thinkingLane: ThinkingLane = new ThinkingLane();
  /**
   * Tracks the currently active loop stage (Observe/Model/Choose/Act/Update)
   * inferred from the live event stream. The orchestrator handler advances
   * this for every event; setComposedOverlay reads the current stage to
   * paint a one-line rail at the top of the live overlay.
   *
   * Reset between turns by `resetStageTracker` callers — for the interactive
   * REPL's purposes a single StreamRenderer instance is constructed per
   * turn, so the natural lifecycle is a fresh tracker per renderer.
   */
  private stageTracker: StageTrackerState = createStageTracker();

  private sources: Map<string, SourceState> = new Map();
  /** Per-subagent streaming markdown renderers, shared with SubagentCtx. */
  private subagentMarkdown = new Map<string, StreamingMarkdownRenderer>();

  /** Last progress event per task — emitted on stream end as a one-line summary. */
  private lastProgressByTask = new Map<string, ProgressEvent>();

  /**
   * Sticky selector for the subagent named in the progress banner's detail slot.
   * Held here (not on the ctx) because `buildOrchestratorCtx` allocates a fresh
   * ctx object per call, which would reset the stickiness on every repaint and
   * reintroduce the child-to-child thrash the hold exists to prevent.
   */
  private childActivity = new ChildActivityTracker();

  /**
   * In-flight tool set backing the spinner's work-derived verb. Spans the
   * orchestrator and all subagents — the verb describes the session, not one
   * source, so a single tracker is correct here.
   */
  private inFlightTools = new InFlightToolTracker();

  private disposed = false;
  private pauseTickInterval: ReturnType<typeof setInterval> | null = null;
  /** ResizeBus unsubscriber — re-derives the overlay at the new terminal width on resize. */
  private resizeUnsub: (() => void) | null = null;
  /** Ticker for subagent elapsed-time updates (250ms); cleared in dispose(). */
  private subagentTickInterval: ReturnType<typeof setInterval> | null = null;
  /** Live status bars for active subagent dispatches, keyed by subagentId. */
  private activeSubagents = new Map<string, SubagentStatusBarSpec>();
  /** Start timestamps (Date.now()) for each active subagent, keyed by subagentId. */
  private subagentStartedAt = new Map<string, number>();
  /**
   * Sum of whole elapsed seconds across all active subagents at the last flush.
   * Drives second-boundary change detection: markDirty + flush only fires when
   * this value changes, matching the pattern used by checkPauseAnnotations.
   */
  private lastSubagentTotalSec = -1;

  /** TTFB elapsed timer: start timestamp + done flag. See stream-renderer-ttfb.ts. */
  private readonly ttfbStartedAt: number | undefined;
  private ttfbDone: boolean;
  /** Last annotation string rendered for the TTFB line — drives 1 Hz change detection. */
  private lastTtfbAnnotation = '';
  /**
   * Braille spinner frame index for the TTFB waiting indicator. Incremented
   * once per second by `checkTtfbAnnotation` (via the lifecycle context
   * write-back in `checkPauseAnnotations`) so the glyph animates at ~1 Hz.
   */
  private ttfbSpinnerFrame = 0;

  /** Ref wired in arm() so the edit-preview hook can push diffs to the tool lane. */
  private readonly addPreviewDiffRef: PreviewDiffRef | undefined;

  /**
   * Pre-bound sink — pass directly to `runWithSink(...)` from callers.
   * Equivalent to `(event, meta) => this.process(event, meta)`.
   */
  readonly sink: (event: OutputEvent, meta?: SubagentProgressMeta) => void;

  constructor(opts: StreamRendererOptions) {
    // Resolve capture-mode first: it can force-downgrade `thinkingMode: 'live'`
    // → `'summary'` because per-thinking-chunk overlay repaints would flood
    // a captured stream with redundant frames. See `_lib/capture-mode.ts`.
    this.captureMode = opts.captureMode ?? detectCaptureMode();
    // Resolve reduced-motion: a user preference to suppress the spinner ticker.
    // Independent of capture-mode (motion sensitivity vs. artifact preservation).
    this.reducedMotion = opts.reducedMotion ?? detectReducedMotion();
    // Defense-in-depth: wrap the line writer with a dedup pass in capture-mode
    // so any future emitter that still floods identical lines into the
    // non-TTY / subagent-commit fallbacks gets collapsed into `… (line
    // repeated N more times)` before reaching the captured stream. Zero
    // impact on live-TTY because capture-mode is gated on the env vars
    // documented in `_lib/capture-mode.ts`.
    //
    // External constraint: only the `line()` channel is dedup-aware; status
    // channels (`success` / `info` / `warn` / `error` / `raw`) bypass dedup
    // AND reset the run-state. See `dedup-line-writer.ts` for the contract.
    //
    // The wrapped writer's `flush()` MUST be called at dispose-time so any
    // trailing suppressed run is summarized in the artifact rather than
    // silently dropped. See `dispose()`.
    this.out = this.captureMode ? makeDedupingLineWriter(opts.out, 2) : opts.out;
    // Resolve thinking mode: explicit option wins; otherwise the deprecated
    // `verbose` boolean maps to 'live' (true) or 'summary' (false/unset).
    // In capture-mode, 'live' is downgraded to 'summary' so the captured
    // artifact records one collapsed summary per turn rather than N
    // overlay-paint frames mid-turn.
    const requestedThinkingMode =
      opts.thinkingMode ?? (opts.verbose === true ? 'live' : 'summary');
    this.thinkingMode = this.captureMode && requestedThinkingMode === 'live'
      ? 'summary'
      : requestedThinkingMode;
    this.onCancel = opts.onCancel;
    this.onBackground = opts.onBackground;

    // AFK_PLAIN_OUTPUT / --plain is a full render opt-out: folding the
    // predicate into isTTY makes every downstream `if (this.isTTY && ...)`
    // branch (compositor construction in arm(), overlay repaints, TTY-only
    // formatting) treat this session as non-TTY, matching the plain path
    // already taken by createReplRenderer() and InputSurface.armCompositor().
    // Reading env here (at construction) is fine — a StreamRenderer is
    // constructed fresh per turn, so a mid-session env change takes effect
    // on the next turn, and the unset case is `false` (zero behavior change).
    this.isTTY = !(opts.forceNonTty ?? false)
      && !isPlainOutputRequested()
      && Boolean(process.stdout.isTTY)
      && Boolean(process.stdin.isTTY);
    this.activeSkillName = opts.activeSkillName;
    this.history = opts.history;
    this.autocompleteState = opts.autocompleteState;
    this.promptText = opts.promptText;
    this.scrollRegion = opts.scrollRegion;
    this.onStageChange = opts.onStageChange;
    if (opts.compositor) {
      this.borrowedCompositor = opts.compositor;
      this.ownsCompositor = false;
    }
    this.ttfbStartedAt = opts.turnStartedAt;
    this.ttfbDone = opts.turnStartedAt === undefined;
    this.addPreviewDiffRef = opts.addPreviewDiffRef;

    this.sink = (event, meta) => this.process(event, meta);
  }

  /**
   * Lazy-arm the TerminalCompositor for TTY-mode live overlays. Skill
   * dispatchers should `await` this before invoking the skill handler so
   * the compositor is ready when the first event arrives. No-op for
   * non-TTY surfaces (Telegram, daemon, tests).
   */
  async arm(): Promise<void> {
    if (this.disposed || !this.isTTY || this.compositor) return;
    let compositor: TerminalCompositor;
    if (this.borrowedCompositor) {
      // Persistent-compositor path (Stage 3b+). The InputSurface armed
      // its compositor at REPL startup and is loaning it for this turn.
      // We attach overlay/spinner state and flip the input mode to
      // 'streaming' so Enter queues (legacy mid-stream behavior); we do
      // NOT re-arm the underlying TerminalCompositor (already armed by
      // the surface) and we do NOT touch its prompt/scrollRegion/history/
      // autocompleteState — those were configured by the owner.
      compositor = this.borrowedCompositor;
      compositor.setInputMode('streaming');
      // Wire the skill's cancel callback onto the borrowed compositor so
      // Ctrl+C during a slash-skill fires the skill's onCancel instead of
      // the REPL's sigintHandler (which is what the compositor held before
      // the borrow).
      //
      // External constraint (ordered-operation sequence): we MUST capture
      // the owner's existing onCancel BEFORE overwriting it, because the
      // owner installed it via the TerminalCompositor constructor — there
      // is no other code path to recover it. dispose() restores this
      // captured handler so between-turns Ctrl+C continues working after
      // the skill exits.
      //
      // Capture is unconditional (even when this.onCancel is undefined)
      // so dispose() can always restore symmetrically. This matters
      // because subagent-render paths may legitimately have no per-skill
      // onCancel but still need the owner's handler preserved.
      this.priorOnCancel = compositor.getOnCancel();
      if (this.onCancel) {
        compositor.setOnCancel(this.onCancel);
      }
    } else {
      // Live-registry adapter for the slash colorizer, built via
      // `createSlashRegistryView()`. Membership delegates to the registry's
      // alias-aware `has()` (queried fresh per render) so plugins that register
      // slash commands mid-session — and aliased commands like `/quit` —
      // colorize correctly without a restart. Mirrors the surface used by
      // `InputSurface` and `readWithAutocompleteTty`.
      const slashRegistryView: SlashRegistryView = createSlashRegistryView();
      compositor = new TerminalCompositor({
        stdout: process.stdout,
        stdin: process.stdin,
        ...(this.onCancel ? { onCancel: this.onCancel } : {}),
        ...(this.onBackground ? { onBackground: this.onBackground } : {}),
        ...(this.history ? { history: this.history } : {}),
        ...(this.autocompleteState ? { autocompleteState: this.autocompleteState } : {}),
        // Conditional spread: the compositor's internal default (a dim chevron
        // glyph) is intentionally the fallback for surfaces that don't pass a
        // prompt — passing `undefined` explicitly here would *also* hit that
        // fallback (the ctor uses `?? default`), but the spread keeps the option
        // bag clean for downstream readers / log diffs / future strict-undefined
        // toggles in the compositor.
        ...(this.promptText !== undefined ? { promptText: this.promptText } : {}),
        formatInputBuffer: (segment) => colorizeInputBuffer(segment, slashRegistryView),
        ...(this.scrollRegion ? { scrollRegion: this.scrollRegion } : {}),
        captureMode: this.captureMode,
        goblinSpinner: detectGoblinSpinner(),
      });
      await compositor.arm();
    }
    this.compositor = compositor;

    // Wire the edit-preview ref so the hook can push diff previews into the
    // tool lane during this turn. No-op when ref is absent (non-REPL surfaces).
    if (this.addPreviewDiffRef) {
      this.addPreviewDiffRef.current = (toolUseId, diff) => {
        this.toolLane.addPreviewDiff(toolUseId, diff);
        this.overlayComposer?.markDirty('tool-lane');
        this.overlayComposer?.flush();
      };
    }

    // Construct the OverlayComposer with the five overlay slot types in z-order.
    // The slots read live state at flush time, so there's no initialization
    // needed beyond construction and registration. 'interrupt' is bottom-most
    // so the live "interrupting…" affordance sits nearest the prompt.
    //
    // Note: 'stage-rail' has been removed from this overlay. The stage rail is
    // now a reserved footer row managed by LoopStageBar (same DECSTBM pattern as
    // BackgroundStatusBar) and painted independently of the compositor frame.
    this.overlayComposer = new OverlayComposer(compositor, [
      'thinking-live',
      'subagent-status',    // live status bars for active subagent dispatches
      'markdown-pending',
      'tool-lane',
      'progress-banner',
      'interrupt',
    ]);

    // Register all six slots via the lifecycle module, which preserves
    // the exact slot order. Each slot's render() method reads the
    // corresponding live state from the renderer's fields at flush time.
    registerOverlaySlots(this.overlayComposer, {
      stageTracker: this.stageTracker,
      thinkingMode: this.thinkingMode,
      thinkingLane: this.thinkingLane,
      streamingMarkdownRef: this.streamingMarkdownRef,
      toolLane: this.toolLane,
      lastProgressByTask: this.lastProgressByTask,
      sources: this.sources,
      childActivity: this.childActivity,
      getInterrupting: () => this.interrupting,
      getSoftStopping: () => this.softStopping,
      getTtfbStartedAt: () => this.ttfbStartedAt,
      isTtfbDone: () => this.ttfbDone,
      getActiveSubagents: () => this.activeSubagents,
    });

    // Reduced-motion suppresses the spinner ticker at the source. State-transition
    // repaints remain active — only the high-frequency 12.5 Hz animation is gated.
    compositor.setSpinner({ enabled: !this.reducedMotion, rotateVerbEveryMs: 3500 });
    this.pauseTickInterval = setInterval(() => this.checkPauseAnnotations(), 80).unref();
    // Subagent elapsed-time ticker: updates activeSubagents' elapsedMs fields and
    // flushes the 'subagent-status' overlay slot every 250ms. Stopped in dispose().
    // markDirty + flush are gated on a second-boundary change: formatElapsed has
    // 1-second granularity, so 3 out of 4 ticks would otherwise produce identical
    // output. We track the sum of whole elapsed seconds across all active subagents
    // and skip the flush when that sum hasn't changed — matching the pattern used
    // by checkPauseAnnotations / lastTtfbAnnotation.
    this.subagentTickInterval = setInterval(() => {
      if (this.disposed || this.activeSubagents.size === 0) return;
      const now = Date.now();
      let totalSec = 0;
      for (const [id, spec] of this.activeSubagents) {
        const startedAt = this.subagentStartedAt.get(id) ?? now;
        const elapsedMs = now - startedAt;
        this.activeSubagents.set(id, { ...spec, elapsedMs });
        totalSec += Math.floor(elapsedMs / 1000);
      }
      if (this.overlayComposer && totalSec !== this.lastSubagentTotalSec) {
        this.lastSubagentTotalSec = totalSec;
        this.overlayComposer.markDirty('subagent-status');
        this.overlayComposer.flush();
      }
    }, 250).unref();
    // Re-derive the composed overlay (tool lane / thinking / progress) at the
    // current terminal width whenever the window resizes. The markdown stream
    // owns its own resize subscription; this covers the rest of the overlay
    // surface. Debounced + coalesced upstream by ResizeBus.
    this.resizeUnsub = subscribeToResize(this.overlayComposer, false);
  }

  /**
   * Public accessor for the underlying TerminalCompositor. Returns null
   * before {@link arm} resolves, on non-TTY surfaces, or after {@link dispose}.
   * Used by the interactive turn handler so a `completionWriter` can route
   * slash-command output (e.g., `/clear`'s rotation message) above the live
   * overlay via `compositor.commitAbove(line)`.
   */
  getCompositor(): TerminalCompositor | null {
    return this.compositor;
  }

  /**
   * Toggle the live "interrupting…" overlay affordance. Called from the REPL
   * SIGINT handler (via the published interrupt notifier) when Ctrl+C is
   * pressed mid-turn, giving immediate feedback that the interrupt registered
   * while the turn winds down.
   *
   * Invariant: the OverlayComposer is the single overlay owner — this flips the
   * 'interrupt' slot's state and triggers exactly one composed flush rather
   * than writing the compositor overlay directly (the corruption-fix contract).
   * Order: mutate state, THEN recompose — never the reverse.
   */
  setInterrupting(active: boolean): void {
    if (this.disposed) return;
    this.interrupting = active;
    if (this.overlayComposer) {
      this.overlayComposer.markDirty('interrupt');
      // Deferred flush: an eager flush() here fires a setOverlay() call that
      // can collide with checkPauseAnnotations' batched flush in the same
      // event-loop turn, producing the same double-setOverlay compositor desync
      // fixed in applyFirstContent / checkTtfbAnnotation. Deferring to the
      // next microtask preserves sub-millisecond visual feedback while
      // eliminating the two-flush race window.
      setTimeout(() => {
        if (!this.disposed) this.overlayComposer?.flush();
      }, 0);
    }
  }

  /**
   * Flip the live "stopping…" progress-banner state on ESC. Mirrors
   * {@link setInterrupting} — the Ctrl+C affordance's sibling.
   */
  setSoftStopping(active: boolean): void {
    if (this.disposed) return;
    this.softStopping = active;
    if (this.overlayComposer) {
      this.overlayComposer.markDirty('progress-banner');
      // Deferred flush — same double-setOverlay race as setInterrupting above.
      setTimeout(() => {
        if (!this.disposed) this.overlayComposer?.flush();
      }, 0);
    }
  }

  /**
   * Strip the terminal-state prose block (Done/Blocked/Asking/Interrupted)
   * from the markdown renderer's pending buffer so the verdict card is the
   * sole visible rendering. Call BEFORE dispose — dispose flushes the pending
   * buffer to scrollback.
   *
   * `headingOffset` is the character offset within the pending buffer where
   * the terminal-state heading starts (from `findTerminalStateHeadingOffset`
   * applied to the buffer, NOT to `responseText`).
   *
   * Returns `true` if the strip succeeded. No-op when the markdown renderer
   * is not alive or the offset is out of bounds.
   */
  stripPendingTerminalState(headingOffset: number): boolean {
    if (this.disposed) return false;
    const md = this.streamingMarkdownRef.current;
    if (!md) return false;
    return md.stripPendingFrom(headingOffset);
  }

  /**
   * Read the raw pending (uncommitted) buffer from the orchestrator's
   * markdown renderer. Returns '' when disposed or no renderer is alive.
   * Used by the turn handler to locate the terminal-state heading within
   * the buffer rather than the full responseText.
   */
  getPendingBuffer(): string {
    if (this.disposed) return '';
    return this.streamingMarkdownRef.current?.getPendingBuffer() ?? '';
  }

  /** Signal first streaming content — clears the TTFB waiting indicator. Idempotent. */
  notifyFirstContent(): void {
    if (this.disposed) return;
    const dirtied = applyFirstContent(
      this.ttfbDone,
      () => { this.ttfbDone = true; },
      this.overlayComposer,
    );
    if (dirtied) {
      // A block-boundary chunk can synchronously drain markdown before this
      // notification marks the banner dirty. Guarantee a later repaint, but
      // put it in a new event-loop turn so it cannot recreate the two-flush
      // race that originally corrupted committed-band geometry.
      setTimeout(() => {
        if (!this.disposed) this.overlayComposer?.flush();
      }, 0);
    }
  }

  /**
   * Build a fresh OrchestratorCtx snapshot from the renderer's live
   * collaborators (compositor, overlay composer, shared tool lane, thinking
   * lane, progress map, …). Both the orchestrator branch and the subagent
   * branch (issue #389) compose overlays through this so EVERY repaint —
   * including those triggered by subagent state transitions — includes the
   * full frame: orchestrator thinking paragraph + shared tool lane + progress
   * banner. Cheap to rebuild per event (a shallow wrapper over shared refs);
   * the orchestrator path already did so inline before this extraction.
   */
  private buildOrchestratorCtx(): OrchestratorCtx {
    return makeOrchestratorCtx({
      out: this.out,
      isTTY: this.isTTY,
      compositor: this.compositor,
      overlayComposer: this.overlayComposer,
      toolLane: this.toolLane,
      thinkingLane: this.thinkingLane,
      thinkingMode: this.thinkingMode,
      streamingMarkdown: this.streamingMarkdownRef,
      coordinator: this.coordinator,
      lastProgressByTask: this.lastProgressByTask,
      sources: this.sources,
      childActivity: this.childActivity,
      ...(this.isTTY ? { stageTracker: this.stageTracker } : {}),
      ...(this.activeSkillName ? { activeSkillName: this.activeSkillName } : {}),
    });
  }

  /**
   * Process one OutputEvent. `meta.subagentId` identifies the source; absent
   * meta is treated as the orchestrator source (`__main__`).
   */
  process(event: OutputEvent, meta?: SubagentProgressMeta): void {
    if (this.disposed) return;
    const ctx: ProcessCtx = {
      out: this.out,
      isTTY: this.isTTY,
      compositor: this.compositor,
      overlayComposer: this.overlayComposer,
      toolLane: this.toolLane,
      thinkingLane: this.thinkingLane,
      streamingMarkdownRef: this.streamingMarkdownRef,
      stageTracker: this.stageTracker,
      coordinator: this.coordinator,
      childActivity: this.childActivity,
      inFlightTools: this.inFlightTools,
      sources: this.sources,
      subagentMarkdown: this.subagentMarkdown,
      lastProgressByTask: this.lastProgressByTask,
      thinkingMode: this.thinkingMode,
      activeSkillName: this.activeSkillName,
      onStageChange: this.onStageChange,
      buildOrchestratorCtx: () => this.buildOrchestratorCtx(),
      activeSubagents: this.activeSubagents,
      subagentStartedAt: this.subagentStartedAt,
      overlayComposerForStatus: this.overlayComposer,
    };
    processEvent(ctx, event, meta);
  }

  /**
   * Flush any pending state and tear down the renderer. Idempotent.
   * Must be called in `finally` after the skill handler resolves.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Reset the preview-diff ref to a no-op so the disposed turn's toolLane
    // reference is released and the hook cannot write into a stale lane.
    if (this.addPreviewDiffRef) this.addPreviewDiffRef.current = () => {};
    // Clear the subagent elapsed-time ticker immediately — it guards against
    // `this.disposed` but clearing here is cleaner and avoids one extra tick.
    if (this.subagentTickInterval !== null) {
      clearInterval(this.subagentTickInterval);
      this.subagentTickInterval = null;
    }
    // Contract: clear softStopping on the class BEFORE building the DisposeCtx
    // snapshot. The overlay's progress-banner slot reads this.softStopping via
    // the getSoftStopping closure registered in arm(), not through the ref
    // wrapper. If we only clear the ref inside disposeRenderer(), the closure
    // still sees true and repaints a stale "stopping…" banner during the
    // overlay flush. The write-back at the end is still needed for consistency.
    this.softStopping = false;
    const ctx: DisposeCtx = {
      out: this.out,
      isTTY: this.isTTY,
      ownsCompositor: this.ownsCompositor,
      compositorRef: { current: this.compositor },
      overlayComposerRef: { current: this.overlayComposer },
      toolLane: this.toolLane,
      streamingMarkdownRef: this.streamingMarkdownRef,
      subagentMarkdown: this.subagentMarkdown,
      lastProgressByTask: this.lastProgressByTask,
      coordinator: this.coordinator,
      resizeUnsubRef: { current: this.resizeUnsub },
      pauseTickIntervalRef: { current: this.pauseTickInterval },
      softStoppingRef: { current: this.softStopping },
      priorOnCancelRef: { current: this.priorOnCancel },
      borrowedCompositorRef: { current: this.borrowedCompositor },
    };
    await disposeRenderer(ctx);
    // Write back the mutable refs that disposeRenderer may have nulled out.
    this.compositor = ctx.compositorRef.current;
    this.resizeUnsub = ctx.resizeUnsubRef.current;
    this.pauseTickInterval = ctx.pauseTickIntervalRef.current;
    this.softStopping = ctx.softStoppingRef.current;
    this.priorOnCancel = ctx.priorOnCancelRef.current;
    this.borrowedCompositor = ctx.borrowedCompositorRef.current;
  }

  /**
   * Bounded stalled-entry lifecycle checker. Called every 80ms by the pause tick interval.
   * checkProgressBannerStaleness (stream-renderer-dead-zone.ts) covers the
   * 8s–30s span of the dead zone by marking the progress-banner slot dirty once
   * a child crosses CHILD_QUIET_MS; checkPauseAnnotations
   * (stream-renderer-lifecycle.ts) then handles the post-30s stall state
   * machine. Both ride the same tick; neither adds a new timer. Return values
   * are intentionally discarded — nothing branches on whether either fired.
   */
  private checkPauseAnnotations(): void {
    const lifecycleCtx = {
      compositor: this.compositor,
      disposed: this.disposed,
      sources: this.sources,
      toolLane: this.toolLane,
      isTTY: this.isTTY,
      overlayComposer: this.overlayComposer,
      stageTracker: this.stageTracker,
      thinkingMode: this.thinkingMode,
      thinkingLane: this.thinkingLane,
      streamingMarkdownRef: this.streamingMarkdownRef,
      lastProgressByTask: this.lastProgressByTask,
      out: this.out,
      pauseTickInterval: this.pauseTickInterval,
      resizeUnsub: this.resizeUnsub,
      ttfbStartedAt: this.ttfbStartedAt,
      ttfbDone: this.ttfbDone,
      lastTtfbAnnotation: this.lastTtfbAnnotation,
      ttfbSpinnerFrame: this.ttfbSpinnerFrame,
    };
    checkProgressBannerStaleness(lifecycleCtx);
    checkPauseAnnotations(lifecycleCtx);
    this.lastTtfbAnnotation = lifecycleCtx.lastTtfbAnnotation;
    this.ttfbSpinnerFrame = lifecycleCtx.ttfbSpinnerFrame;
  }

}

// `Message` re-export so test imports keep type ergonomics tight without
// pulling from agent/types directly.
export type { Message };
