/**
 * StreamRendererOptions interface — construction-time configuration for
 * StreamRenderer. Extracted from stream-renderer.ts to decompose the class
 * into focused concern modules while keeping the main file under 350 lines.
 *
 * @module cli/_lib/stream-renderer-options
 */

import type { Writer } from '../slash/types.js';
import type { IHistoryRing } from '../input/types.js';
import type { AutocompleteState } from '../input/autocomplete-state.js';
import type { TerminalCompositor } from '../terminal-compositor.js';

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
  onStageChange?: (
    stage: import('../commands/interactive/loop-stage.js').LoopStage,
    signals?: import('../commands/interactive/loop-stage.js').StageSignals,
  ) => void;
  /**
   * The timestamp at which the current turn started (typically `Date.now()` at
   * the moment the user submitted the prompt). When provided and the TUI is
   * active, the renderer shows a "waiting for response… Ns" line in the
   * progress-banner overlay slot while no streaming content has arrived yet —
   * bridging the TTFB (time-to-first-byte) dead zone where the terminal would
   * otherwise show no feedback. The elapsed counter updates ~1s via the
   * existing `checkPauseAnnotations` 80ms ticker (same mechanism as the
   * `· waiting Ns` stall annotation, which fires when annotation text changes).
   *
   * Ignored when omitted or when `isTTY` is false (non-interactive surfaces
   * have no overlay to drive). The timer clears automatically when the first
   * streaming content chunk arrives (see `notifyFirstContent`).
   */
  turnStartedAt?: number;
}
