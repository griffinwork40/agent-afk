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
import { debugLog } from '../../utils/debug.js';
import type { Message } from '../../agent/types/message-types.js';
import type { Writer } from '../slash/types.js';
import { TerminalCompositor } from '../terminal-compositor.js';
import type { IHistoryRing } from '../input/types.js';
import type { AutocompleteState } from '../input/autocomplete-state.js';
import { colorizeInputBuffer, type SlashRegistryView } from '../input-highlight.js';
import { list as listSlashCommands } from '../slash/registry.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import {
  ORCHESTRATOR_SOURCE_KEY,
  type SourceState,
  freshSourceState,
} from './stream-renderer-source.js';
import {
  handleOrchestratorEvent,
  setComposedOverlay,
  type OrchestratorCtx,
} from './stream-renderer-orchestrator.js';
import { CommitCoordinator } from './commit-coordinator.js';
import { commitBlockAbove } from './commit-block.js';
import { handleSubagentEvent, synthesizeAgentEntry } from './stream-renderer-subagent.js';
import { OverlayComposer } from './overlay-composer.js';
import { createStageTracker, type StageTrackerState } from '../commands/interactive/loop-stage.js';
import { detectCaptureMode, detectReducedMotion, detectGoblinSpinner } from './capture-mode.js';
import { makeDedupingLineWriter, type DedupingLineWriter } from './dedup-line-writer.js';
import { registerOverlaySlots, checkPauseAnnotations, subscribeToResize } from './stream-renderer-lifecycle.js';
import { makeOrchestratorCtx, makeSubagentCtx, resolveParentSyntheticId } from './stream-renderer-contexts.js';

export interface StreamRendererOptions {
  /** Where line-based output goes (non-TTY fallback + always-emitted compact lines). */
  out: Writer;
  /**
   * Controls how orchestrator-side thinking is rendered:
   * - `'off'` — suppressed entirely (no buffer, no overlay, no summary)
   * - `'summary'` (default) — buffered, collapsed summary emitted on finalize
   * - `'live'` — preview overlay during streaming, plus finalize summary
   *
   * Subagent thinking is always suppressed regardless of this flag.
   */
  thinkingMode?: 'off' | 'summary' | 'live' | 'digest';
  /**
   * @deprecated Use `thinkingMode: 'live'` instead. Kept as a back-compat alias:
   * `verbose: true` maps to `thinkingMode: 'live'`, `false`/unset to `'summary'`.
   */
  verbose?: boolean;
  /** Optional cancel callback wired into TerminalCompositor (e.g., session.interrupt). */
  onCancel?: () => void;
  /** Optional background callback wired into TerminalCompositor (Ctrl+B). */
  onBackground?: () => void;
  /**
   * Force the line-based fallback regardless of TTY detection. Used by tests
   * and by surfaces that don't have a real terminal (Telegram, daemon).
   */
  forceNonTty?: boolean;
  /**
   * Active skill name (e.g. `'ship'`). When set, the orchestrator converts
   * the model's `<skillname>` content tags into a styled visual badge.
   */
  activeSkillName?: string;
  /**
   * Shared history ring from the REPL session. When provided, the compositor
   * supports ↑/↓ history navigation during the agent turn.
   */
  history?: IHistoryRing;
  /**
   * Shared autocomplete dropdown state from the REPL session. When provided,
   * the compositor renders the autocomplete dropdown inside the log-update
   * frame and keeps state consistent with the between-turn prompt surface.
   */
  autocompleteState?: AutocompleteState;
  /**
   * Prompt prefix rendered at the start of the input row inside the
   * compositor frame. Captured once at construction — plan-mode and model
   * toggles only flip between turns, so a fresh per-turn string is
   * sufficient and matches the lifetime of this StreamRenderer instance.
   *
   * When omitted, the compositor falls back to its internal default
   * (a dim chevron glyph). REPL turn paths supply the canonical
   * `afk (model) ›` form so the agent-turn input row matches the
   * between-turn prompt; standalone slash-command StreamRenderers
   * (which spawn outside the main REPL ctx) may omit it.
   *
   * Ignored when {@link compositor} is supplied — the borrowed
   * compositor's prompt was set by its owner (InputSurface) and is
   * not mutated per-turn.
   */
  promptText?: string;
  /**
   * Optional DECSTBM scroll-region guard (typically the active StatusLine).
   * Forwarded to the TerminalCompositor so its `commitAbove` writes use
   * full-screen scroll semantics instead of being clipped by the
   * sub-region scroll. Required to keep scrollback intact when a status
   * line is active — REPL turn paths supply it; standalone slash-command
   * StreamRenderers (which spawn outside the main REPL ctx) may omit it
   * and accept the legacy behavior.
   *
   * Ignored when {@link compositor} is supplied — the borrowed
   * compositor's scroll region was wired by its owner.
   */
  scrollRegion?: { withFullScrollRegion<T>(fn: () => T): T; getExtraRows(): number };
  /**
   * Capture-mode override. When omitted, resolved via `detectCaptureMode()`
   * which reads `AFK_DEMO_CLEAN` / `SCRIPT` / `ASCIINEMA_REC` env vars.
   * Tests pass `false` explicitly to keep the live-TTY behavior even when
   * vitest is run under one of those env vars.
   *
   * When effective: suppresses the spinner ticker (no 12.5 Hz background
   * repaints) and downgrades `thinkingMode: 'live'` → `'summary'` so the
   * per-thinking-chunk overlay paints do not flood a captured stream.
   * See `_lib/capture-mode.ts` for the full rationale.
   */
  captureMode?: boolean;
  /**
   * Reduced-motion mode override. When omitted, resolved via
   * `detectReducedMotion()` which reads the `AFK_REDUCED_MOTION` env var.
   *
   * When effective: suppresses the spinner ticker animation at the
   * stream-renderer call site (no 12.5 Hz background repaints), while leaving
   * state-transition-driven repaints unaffected. A user preference for motion
   * sensitivity, distinct in intent from capture-mode. See `_lib/capture-mode.ts`.
   */
  reducedMotion?: boolean;
  /**
   * Borrow an externally-armed TerminalCompositor instead of
   * constructing + arming one internally. Used by the persistent
   * InputSurface (Stage 3b+) so the same compositor serves both the
   * idle-between-turns input row and the streaming agent-turn overlay.
   *
   * When provided:
   *   - {@link arm} skips compositor construction; spinner/resize wiring
   *     attach to the borrowed instance instead.
   *   - The compositor's input mode is flipped to `'streaming'` so
   *     Enter queues (legacy behavior). The surface flipped it to
   *     `'idle'` before this point — arm flips back; dispose flips to
   *     `'idle'` again, which fires onSubmit for any queued buffer.
   *   - {@link dispose} clears spinner + overlay and restores idle
   *     mode, but does NOT disarm the compositor — its lifetime is
   *     owned by the surface (REPL startup → REPL exit).
   *
   * When omitted (the historical path), the renderer constructs and
   * disposes its own compositor as before. All non-REPL callers
   * (skills, standalone slash dispatchers, tests) use this path.
   */
  compositor?: TerminalCompositor;
  /**
   * Optional callback fired whenever the loop stage transitions
   * (Observe → Model → Choose → Act → Update). Carries the new stage.
   *
   * Used by the REPL to repaint the `LoopStageBar` reserved footer row
   * without the bar needing to poll or be threaded through the compositor.
   * The callback fires in `process()` when `advanceStage` returns true.
   *
   * Best-effort: if the callback throws the error is swallowed so a bar
   * paint failure never breaks the streaming event loop.
   */
  onStageChange?: (stage: import('../commands/interactive/loop-stage.js').LoopStage) => void;
}

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
  private readonly onStageChange: ((stage: import('../commands/interactive/loop-stage.js').LoopStage) => void) | undefined;
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
   * Captured owner-side onCancel from the borrowed compositor at {@link arm}
   * time, so {@link dispose} can restore it after this renderer swaps in
   * its own onCancel for the turn. Distinguishes "owner had no handler"
   * (undefined) from "we never armed against a borrow" (the borrowedCompositor
   * field being null is the source of truth for that — this field is only
   * meaningful when ownsCompositor === false).
   *
   * Required because the owner (InputSurface.armCompositor) installs its
   * sigintHandler via the compositor constructor; there is no other code path
   * to recover it. Without capture+restore, calling setOnCancel(null) on
   * dispose would silently break between-turns Ctrl+C after the first borrow
   * (the compositor's onCancel becomes undefined, and idle-mode Ctrl+C is a
   * no-op when onCancel is unset — terminal-compositor.ts:1106-1108).
   */
  private priorOnCancel: (() => void) | undefined = undefined;

  /** Live interrupt state — flipped by {@link setInterrupting} on Ctrl+C. */
  private interrupting = false;

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

  private disposed = false;
  private pauseTickInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * ResizeBus unsubscriber. Set in `arm()`, cleared in dispose. The handler
   * re-derives the composed overlay (tool lane + thinking + progress banner)
   * at the new terminal width via `setComposedOverlay` — without this, the
   * tool-lane overlay stays wrapped at the width-at-last-event after a
   * window resize. The `StreamingMarkdownRenderer` handles its own resize
   * subscription for the markdown overlay path; this hook covers everything
   * the markdown stream is NOT responsible for.
   *
   * Safe to fire when no overlay is active: `setComposedOverlay` is a no-op
   * when none of {stageTracker, thinkingLane, toolLane, lastProgressByTask}
   * contribute content.
   */
  private resizeUnsub: (() => void) | null = null;

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

    this.isTTY = !(opts.forceNonTty ?? false)
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
      // Live-registry adapter — queried fresh on every render so plugins that
      // register slash commands mid-session colorize correctly without a
      // restart. Mirrors the closure used by `readWithAutocompleteTty` at
      // src/cli/input/reader.ts:103-105. `listSlashCommands()` returns names
      // prefixed with `/`; the highlighter passes the bare name, so we
      // re-add the prefix in the predicate.
      const slashRegistryView: SlashRegistryView = {
        has: (name) => listSlashCommands().some((c) => c.name === `/${name}`),
      };
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
      'markdown-pending',
      'tool-lane',
      'progress-banner',
      'interrupt',
    ]);

    // Register all five slots via the lifecycle module, which preserves
    // the exact slot order. Each slot's render() method reads the
    // corresponding live state from the renderer's fields at flush time.
    registerOverlaySlots(this.overlayComposer, {
      stageTracker: this.stageTracker,
      thinkingMode: this.thinkingMode,
      thinkingLane: this.thinkingLane,
      streamingMarkdownRef: this.streamingMarkdownRef,
      toolLane: this.toolLane,
      lastProgressByTask: this.lastProgressByTask,
      getInterrupting: () => this.interrupting,
    });

    // Reduced-motion suppresses the spinner ticker at the source. State-transition
    // repaints remain active — only the high-frequency 12.5 Hz animation is gated.
    compositor.setSpinner({ enabled: !this.reducedMotion, rotateVerbEveryMs: 3500 });
    this.pauseTickInterval = setInterval(() => this.checkPauseAnnotations(), 80);
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
      this.overlayComposer.flush();
    }
  }


  /**
   * Process one OutputEvent. `meta.subagentId` identifies the source; absent
   * meta is treated as the orchestrator source (`__main__`).
   */
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
      ...(this.isTTY ? { stageTracker: this.stageTracker } : {}),
      ...(this.activeSkillName ? { activeSkillName: this.activeSkillName } : {}),
    });
  }

  process(event: OutputEvent, meta?: SubagentProgressMeta): void {
    if (this.disposed) return;

    const sourceId = meta?.subagentId ?? ORCHESTRATOR_SOURCE_KEY;
    const isOrchestrator = sourceId === ORCHESTRATOR_SOURCE_KEY;
    let source = this.sources.get(sourceId);

    if (!source) {
      source = freshSourceState(meta?.agentType);
      this.sources.set(sourceId, source);
      if (!isOrchestrator) {
        // Synthesize the `Agent(<label>)` parent on the very first event.
        // Resolve nesting in priority order when `meta.parentId` is present.
        // No deferred synthesis, no retroactive re-tagging.
        const parentSyntheticId = resolveParentSyntheticId({
          parentId: meta?.parentId,
          sources: this.sources,
          toolLane: this.toolLane,
          sourceId,
        });
        synthesizeAgentEntry(sourceId, source, makeSubagentCtx({
          isTTY: this.isTTY,
          compositor: this.compositor,
          toolLane: this.toolLane,
          out: this.out,
          streamingMarkdown: this.subagentMarkdown,
          thinkingMode: this.thinkingMode,
          orchestratorCtx: this.buildOrchestratorCtx(),
        }), parentSyntheticId);
      }
    }

    if (isOrchestrator) {
      // Snapshot the stage before the event so we can fire onStageChange
      // exactly when the stage transitions (not on every event).
      const stageBefore = this.stageTracker.stage;
      handleOrchestratorEvent(event, source, this.buildOrchestratorCtx());
      // Fire onStageChange when the loop stage transitions so the LoopStageBar
      // footer row repaints immediately — without polling or threading the bar
      // through the overlay compositor. Swallows errors defensively.
      if (this.onStageChange && this.stageTracker.stage !== stageBefore) {
        try { this.onStageChange(this.stageTracker.stage); } catch { /* best-effort */ }
      }
    } else {
      handleSubagentEvent(event, sourceId, source, makeSubagentCtx({
        isTTY: this.isTTY,
        compositor: this.compositor,
        toolLane: this.toolLane,
        out: this.out,
        streamingMarkdown: this.subagentMarkdown,
        thinkingMode: this.thinkingMode,
        orchestratorCtx: this.buildOrchestratorCtx(),
      }));
      // Refresh staleness timestamp and clear any pause annotation on new activity.
      source.lastEventAt = Date.now();
      if (source.pauseAnnotation !== undefined && source.syntheticAgentToolUseId) {
        source.pauseAnnotation = undefined;
        // Reset stall counter — a heartbeat proves the source is alive again.
        // Without this reset, K stalled ticks → heartbeat → K more ticks would
        // fire the hard cutoff at 2K cumulative (30s after resume) instead of
        // requiring 2K continuous ticks (60s) of new silence.
        source.stalledTicks = 0;
        const label = source.agentType ?? sourceId;
        this.toolLane.addStartWithAgentContext(
          source.syntheticAgentToolUseId, 'Agent', `(${label})`, undefined,
        );
      }
      // Terminal event for a subagent stream: 'done' (normal completion) OR
      // 'error' (aborted, timed-out, or provider-side failure). Both must
      // trigger the same flush-to-scrollback path so the user sees the
      // partial work in scrollback rather than losing it when the live
      // overlay is torn down at turn end.
      //
      // History: pre-this-fix, only 'done' triggered the flush. Ctrl+C
      // cascades aborts via AbortGraph; each subagent's iterator throws
      // AbortError; each subagent emits `event.type === 'error'` (NOT done).
      // The 'error' branch in handleSubagentEvent
      // (stream-renderer-subagent.ts:408-432) sets source.errored = true,
      // calls addResult with the error message, and refreshes the live
      // overlay — but never schedules a coordinator batch or drains the
      // subagent block to scrollback. The lane entry then either gets
      // wiped by the dispose() safety net (with its own scrollback-push
      // limitations) or by overlay.setOverlay('') at borrow-dispose,
      // dropping the user's view of what the subagent was working on.
      //
      // The merged Agent root entry has agent.result set by addResult
      // (either an error-result for 'error' or a synthetic done-result
      // for 'done'), so flushSource() renders the block correctly in both
      // cases. The user sees the in-flight tool calls + the error/done
      // summary line for any subagent that produced events before
      // terminating.
      const isTerminal = event.type === 'done' || event.type === 'error';
      if (isTerminal && this.isTTY) {
        // Flush only this subagent's entries (parent + children) — other
        // sources' entries remain in the overlay for still-running sub-agents.
        const syntheticId = source.syntheticAgentToolUseId;
        if (syntheticId && this.toolLane.hasEntry(syntheticId)) {
          const lines = this.toolLane.flushSource(syntheticId);
          const compositor = this.compositor;
          const overlayComposer = this.overlayComposer;
          const toolLane = this.toolLane;
          const out = this.out;
          this.coordinator.schedule({
            anchor: `after-subagent:${sourceId}`,
            commits: [() => {
              if (compositor) {
                // Atomic block commit — a subagent block is ONE coherent
                // artifact; per-line commits desync band-hold under a tall
                // overlay. See commit-block.ts.
                commitBlockAbove(compositor, lines);
                // One blank line after the subagent block so the next
                // orchestrator message (or a subsequent subagent block) has
                // breathing room in scrollback.
                compositor.commitAbove('');
                // Route the overlay update through the composer if available.
                if (overlayComposer) {
                  overlayComposer.markDirty('tool-lane');
                  overlayComposer.flush();
                } else {
                  compositor.setOverlay(toolLane.getOverlay());
                }
              } else {
                for (const line of lines) out.line(line);
                out.line('');
              }
            }],
          });
          // Eager drain: commit subagent done-blocks to scrollback at the
          // event-timeline position where the subagent FINISHED, not at the
          // end of the turn. This is the fix for the "subagent rows pile up
          // at the bottom" regression — without it, every Agent(...) block
          // is deferred to flushAll() step 3 and lands below all prose.
          //
          // Bug #1 invariant preservation: before draining the subagent block,
          // synchronously flush any pending markdown buffer via commitPending().
          // The real StreamingMarkdownRenderer.commitPending() writes the
          // ENTIRE buffer to scrollback via compositor.commitAbove (see
          // markdown-stream.ts:191 — commitBlock commits whatever is in the
          // buffer, partial-block included). This means all prose generated
          // BEFORE the subagent's done-event lands above the subagent block,
          // satisfying the "completed prose before subagent block" ordering
          // invariant. Any subsequent orchestrator prose pushes into a fresh
          // empty buffer and naturally lands below the subagent block —
          // which is the desired chronological interleave.
          //
          // External constraint (pattern card: ordered-sequences governed by
          // append-only scrollback): commitPending MUST run before
          // drainSubagent. Append-only scrollback cannot retroactively insert
          // prose above a previously-committed line.
          try {
            if (this.streamingMarkdownRef.current) {
              this.streamingMarkdownRef.current.commitPending();
            }
          } finally {
            // Invariant: drain MUST run even if commitPending throws — otherwise the
            //   after-subagent batch in CommitCoordinator is permanently stranded.
            //   Idempotency: drainSubagent deletes the batch on first execution, so a
            //   later flushAll call is a no-op.
            // History: an earlier `hasEmitted()` markdown-renderer guard could skip
            //   drain on zero-emission subagents. Safety after removal: (1) the
            //   coordinator.schedule(...) call above always registers a batch before
            //   this drain runs, and (2) drainSubagent no-ops when no batch exists
            //   (commit-coordinator.ts `if (batches)` guard).
            this.coordinator.drainSubagent(sourceId);
          }
        }
        setComposedOverlay(this.buildOrchestratorCtx());
      }
    }
  }

  /**
   * Flush any pending state and tear down the renderer. Idempotent.
   * Must be called in `finally` after the skill handler resolves.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Drop the resize subscription FIRST so any in-flight debounced fire
    // doesn't land on a half-torn-down ctx — `setComposedOverlay` reads the
    // tool lane and compositor, both of which are about to be released.
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }

    // Defensive eviction of any live progress entry. finalizeOrchestrator
    // already clears this on the 'done' path; this covers turns that reach
    // dispose without a 'done' event (error aborts, interrupts) so the
    // overlay flushes below never repaint a stale progress banner.
    this.lastProgressByTask.clear();

    // CommitCoordinator.flushAll() is the single async owner at turn end.
    // It drains all scheduled commit batches in fixed anchor order:
    //   1. before-content (orchestrator tool-lane entries that precede prose)
    //   2. await streamingMarkdown.flush() — injected here as the markdown flush
    //   3. after-subagent:* (subagent result blocks, in registration order)
    //   4. after-content (thinking summaries, skill badges, panels)
    //
    // External constraint: this call MUST come before any cleanup that would
    // null streamingMarkdownRef.current or dispose the compositor — the
    // coordinator's step 2 and steps 3–4 need both alive.
    //
    // The markdown renderer is passed as a bound flush callback rather than
    // a stored reference so CommitCoordinator doesn't hold a direct dependency
    // on StreamingMarkdownRenderer.
    const markdownFlush = this.streamingMarkdownRef.current
      ? () => this.streamingMarkdownRef.current!.flush()
      : undefined;
    await this.coordinator.flushAll(markdownFlush);

    // Orchestrator markdown — dispose after coordinator has flushed it.
    if (this.streamingMarkdownRef.current) {
      this.streamingMarkdownRef.current.dispose();
      this.streamingMarkdownRef.current = null;
    }

    // Subagent markdown renderers — flush and dispose any still active.
    // These are NOT coordinator-managed (each subagent markdown stream has
    // its own lifecycle); best-effort flush for any stragglers.
    for (const renderer of this.subagentMarkdown.values()) {
      try { await renderer.flush(); } catch { /* best effort */ }
      renderer.dispose();
    }
    this.subagentMarkdown.clear();

    // ToolLane — flush any pending entries that weren't captured by the
    // coordinator (e.g. entries registered after flushAll ran, or in
    // non-coordinator paths). This is the safety net; in normal operation
    // the coordinator drains all tool-lane commits before this point.
    //
    // Invariant (TUI rhythm contract): the safety-net flush is an emitter
    // like any other, so it MUST own ONE trailing blank after its lines.
    // The post-dispose successor (verdict card, soft-stop notice, footer)
    // never emits a leading blank, so without this trailing the footer
    // would butt directly against the last tool result. Mirrors the
    // coordinator done-path at stream-renderer-orchestrator.ts:363-382.
    // See docs/tui-rhythm.md.
    if (this.toolLane.hasPending()) {
      const lines = this.toolLane.flush();
      if (this.isTTY && this.compositor) {
        // Atomic block commit — the safety-net flush is ONE coherent block;
        // per-line commits desync band-hold under a tall overlay. See
        // commit-block.ts.
        commitBlockAbove(this.compositor, lines);
        this.compositor.commitAbove('');
        if (this.overlayComposer) {
          this.overlayComposer.markDirty('tool-lane');
          this.overlayComposer.flush();
        } else {
          this.compositor.setOverlay(this.toolLane.getOverlay());
        }
      } else {
        for (const line of lines) this.out.line(line);
        this.out.line('');
      }
    }

    if (this.pauseTickInterval) {
      clearInterval(this.pauseTickInterval);
      this.pauseTickInterval = null;
    }

    if (this.compositor) {
      if (this.ownsCompositor) {
        // Renderer-owned compositor — full teardown.
        try { this.compositor.disarm(); } catch { /* best effort */ }
      } else {
        // Borrowed compositor — leave it armed for the surface to keep
        // serving the idle input row. Reset the streaming-only state
        // (spinner + overlay) so the bottom region looks clean; flip
        // input mode back to 'idle' so the next Enter resolves the
        // surface's pending readLine.
        //
        // Ordered-operation invariant (sequence): clear overlay BEFORE
        // flipping mode. setInputMode('idle') can synchronously fire
        // onSubmit (when a buffer was queued mid-stream) which may
        // trigger the surface to commitAbove the user's submission
        // echo. That echo must commit above a CLEAN bottom region, not
        // above a stale spinner frame from the just-ended turn.
        //
        // Failure-isolation invariant (per-step try/catch): each call
        // gets its own try/catch. A single bundled try/catch lets a
        // throw in setSpinner silently skip setOverlay('') and
        // setInputMode('idle') — leaving the stale frame painted
        // (compositor stuck "on top") and the surface stuck in
        // 'streaming' mode. The throw is reachable in production:
        // logUpdate() can propagate EPIPE/EBADF when the TTY closes
        // mid-session (see terminal-compositor.ts:676). Per-step
        // isolation keeps the sequence above intact under partial
        // failure: setOverlay still runs even if setSpinner threw.
        try {
          this.compositor.setSpinner({ enabled: false });
        } catch (e) {
          debugLog('[stream-renderer] borrow-dispose setSpinner: ' + String(e));
        }
        try {
          if (this.overlayComposer) {
            this.overlayComposer.invalidate();
            this.overlayComposer.flush();
          } else {
            this.compositor.setOverlay('');
          }
        } catch (e) {
          debugLog('[stream-renderer] borrow-dispose setOverlay: ' + String(e));
        }
        try {
          this.compositor.setInputMode('idle');
        } catch (e) {
          debugLog('[stream-renderer] borrow-dispose setInputMode: ' + String(e));
        }
        // Restore the compositor's cancel handler to whatever the owner had
        // installed before arm() swapped in this.onCancel. The owner
        // (InputSurface.armCompositor) installs its sigintHandler via the
        // TerminalCompositor constructor — there is no other path to recover
        // it. Setting null here would leave onCancel === undefined, and
        // idle-mode Ctrl+C silently no-ops in that state
        // (terminal-compositor.ts:1106-1108).
        //
        // Passing `this.priorOnCancel ?? null` is type-safe: setOnCancel(null)
        // maps to `this.onCancel = undefined` internally, which is the
        // correct between-turns state ONLY when the owner never installed a
        // handler in the first place (priorOnCancel was undefined at capture).
        try {
          this.compositor.setOnCancel(this.priorOnCancel ?? null);
        } catch (e) {
          debugLog('[stream-renderer] borrow-dispose setOnCancel: ' + String(e));
        }
        // Clear our captured reference so a re-dispose (defensive idempotent
        // call) doesn't try to restore a stale handler.
        this.priorOnCancel = undefined;
      }
      this.compositor = null;
      this.borrowedCompositor = null;
    }

    // Capture-mode tail: if `this.out` is a deduping wrapper, finalize any
    // suppressed trailing run so the artifact ends with an honest summary.
    // Idempotent + safe when `this.out` is the bare opts.out (i.e. when
    // capture-mode was off and no wrapping happened).
    //
    // External constraint (pattern card: ordered-sequences): this MUST run
    // AFTER all upstream writes are drained (the compositor.disarm above is
    // the last writer in the teardown chain). Otherwise a late line written
    // post-flush would have no summary line preceding it.
    const maybeDedup = this.out as Partial<DedupingLineWriter>;
    if (typeof maybeDedup.flush === 'function') {
      try { maybeDedup.flush(); } catch { /* best effort */ }
    }
  }

  /**
   * Bounded stalled-entry lifecycle checker. Called every 80ms by the pause tick interval.
   * Delegates to the lifecycle module to keep core class compact.
   */
  private checkPauseAnnotations(): void {
    checkPauseAnnotations({
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
    });
  }

}

// `Message` re-export so test imports keep type ergonomics tight without
// pulling from agent/types directly.
export type { Message };
