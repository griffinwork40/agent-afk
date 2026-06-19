/**
 * Types, constants, and pure helpers extracted from terminal-compositor.ts.
 *
 * Kept in a separate file so the ~2 KB of interface declarations and small
 * utility functions do not clutter the stateful TerminalCompositor class.
 * Everything here is import-side-effect-free and has no dependency on
 * `this` — pure module-level declarations only.
 */

import { palette } from './palette.js';
import { displayWidth, truncateDisplayWidth } from './display.js';
import type { LoadingTip } from './loading-tips.js';
import type { ImageAttachment } from './input/attachments.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { IHistoryRing } from './input/types.js';
import type { SuggestEngine, SuggestContext } from './input/suggest.js';

export type { SuggestEngine, SuggestContext };

export interface LogUpdateFn {
  render: (content: string, targetBottomRow: number, anchorFloor?: number) => void;
  clear: (extraRows?: number) => void;
  done: () => void;
  /**
   * Optional accessor exposed by CupFrameRenderer. Returns the row where
   * the most-recently rendered frame's top sits, or 0 if no frame has
   * been rendered since the last clear. Used by `commitAbove`'s phase 3
   * to write the committed text at `topRow - lineCount..topRow - 1`
   * (immediately above the new live frame) so it's visible without
   * scrolling in addition to being preserved in scrollback by phase 1.
   */
  readonly topRow?: number;
  /**
   * Optional method exposed by CupFrameRenderer. Drops tracked previous-
   * frame coordinates so the next render() skips its erase pass and does
   * a fresh full-paint at current `stdout.rows`/`columns`. Wired to the
   * immediate (non-debounced) ResizeBus channel to invalidate geometry
   * synchronously on SIGWINCH — before any spinner tick or subagent
   * event in the 150ms debounce window can call repaint() with stale
   * coordinates.
   */
  resetGeometry?: () => void;
  /**
   * Optional method exposed by CupFrameRenderer. Predicts the physical top row
   * the next `render(content, targetBottomRow)` will use (after hard-wrapping
   * at `stdout.columns`), without rendering or mutating tracked state. Used by
   * `repaint()`/`repaintPickerFrame()` to size committed-band eviction + re-pin
   * against the PHYSICAL frame footprint rather than the logical line count,
   * which under-counts whenever a frame line soft-wraps (review #592). Absent on
   * test stubs — callers fall back to the logical line count.
   */
  measure?: (content: string, targetBottomRow: number) => { topRow: number; lineCount: number };
}

export interface KeyInfo {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

// Braille spinner frames from ora's `dots` preset.
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const ELAPSED_GRACE_MS = 5_000;

export function formatElapsed(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  if (elapsed < ELAPSED_GRACE_MS) return '';
  const totalSec = Math.floor(elapsed / 1000);
  if (totalSec < 60) return palette.dim(` ${totalSec}s`);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return palette.dim(` ${min}m${sec.toString().padStart(2, '0')}s`);
}

/**
 * Absolute-position erase-and-paint of one terminal row, returned as a string
 * for accumulation into a batched write (never written directly here).
 *
 * Emits CUP (`\x1b[{row};1H` — cursor to column 1 of `row`) then EL
 * (`\x1b[2K` — erase entire line), then `line`. Omitting `line` (or passing
 * `undefined`) erases the row and writes nothing — the bare-erase form.
 *
 * Invariant: emits NO `\n`, so callers that rely on CUP+EL writes never
 * triggering the DECSTBM scroll region stay correct. Shared by the
 * committed-band commit/repin and frame-preserve render paths, which batch
 * these into one `out` string before a single `stdout.write`.
 */
export function eraseAndPaintRow(row: number, line?: string): string {
  return `\x1b[${row};1H\x1b[2K${line ?? ''}`;
}

/**
 * Format a loading tip into the dim 💡 row that sits beneath the spinner.
 *
 * The literal `Tip:` label is load-bearing, not decoration: most tips are
 * harvested skill hints shaped like `/agentify — Use when …`, and without
 * the label a tip rendered mid-turn reads as the agent announcing it is
 * routing to that skill (e.g. the user types `/automate` and immediately
 * sees `💡 /agentify — Use when…`). `Tip:` marks the row as ambient
 * guidance, decoupled from the in-flight turn. The {@link LoadingTip}
 * contract has always promised this prefix; the implementation drifted.
 *
 * `cols` is the terminal width — we truncate to fit on one visual line so
 * the tip never wraps and steals a viewport row that log-update can't
 * cleanly reclaim on the next paint. The prefix budget is "  💡 Tip: "
 * (10 visible cols); 1 more col is reserved for the trailing "…" when
 * truncation kicks in. Budget and truncation are measured in DISPLAY
 * columns (not JS chars) so wide glyphs (CJK, emoji) in a tip body cannot
 * overflow the row — char-count truncation would under-truncate them 2:1.
 */
export function formatTipRow(text: string, cols: number): string {
  const prefix = '  💡 Tip: ';
  // Reserve the prefix chrome and 1 col for the truncation marker so the
  // rendered line always fits in `cols` regardless of body length.
  const bodyBudget = Math.max(8, cols - displayWidth(prefix) - 1);
  const body =
    displayWidth(text) > bodyBudget
      ? truncateDisplayWidth(text, Math.max(0, bodyBudget - 1), '') + '…'
      : text;
  return palette.dim(prefix + body);
}

export interface SpinnerState {
  frameIndex: number;
  verb: string;
  nextVerbRotateAt: number;
  startedAt: number;
  /**
   * Snapshot of the tip pool, harvested at setSpinner-time. Frozen for the
   * lifetime of the spinner — re-harvesting per frame would race against
   * mid-turn registry mutations (plugin (re)loads) and isn't worth it; tips
   * are advisory and a few-second staleness is invisible.
   */
  tipPool: readonly LoadingTip[];
  /**
   * Currently-displayed tip. Computed on every tick via `selectTip` —
   * cheap, time-stable, and the tick is the only place we need to refresh
   * after warmup. Null until warmup elapses or while the pool is empty.
   */
  currentTip: LoadingTip | null;
}

/**
 * Minimal structural type for the DECSTBM guard supplied by StatusLine.
 * Mirrors the contract used in repl-renderer.ts. When provided, the
 * compositor wraps its `commitAbove` write so the `\n` produces a
 * scrollback-bound full-screen scroll rather than a sub-region scroll
 * that would silently discard displaced lines.
 */
export interface CompositorScrollRegionGuard {
  withFullScrollRegion<T>(fn: () => T): T;
  /** Returns the number of rows reserved below the scroll region (e.g. for BackgroundStatusBar). */
  getExtraRows(): number;
}

/**
 * Input mode controls how Enter resolves.
 *
 * - `'streaming'` (default) — Enter on a non-empty buffer COMMITS it to the
 *   pending-submission FIFO and clears the input so the next message composes
 *   fresh (multi-message type-ahead). Used by the agent-turn compositor where
 *   the user queues messages while the agent finishes; each drains as its own
 *   turn (see below).
 * - `'idle'` — Enter on a non-empty buffer fires `onSubmit(buffer)`
 *   immediately and clears the buffer. Used by the persistent
 *   InputSurface between turns (Stage 3b+) so the same compositor
 *   serves both phases without a disarm/rearm cycle.
 * - `'picker'` — the input region is rented out to a transient
 *   arrow-key picker (see {@link PickerController}). All keystrokes
 *   are routed to the picker's `onKey`; the input buffer is hidden
 *   and untouched until `exitPickerMode()` restores the previous
 *   `idle`/`streaming` mode. Used by `ask_question` choice/multi_choice
 *   elicitations to render an inquirer-style in-place selector.
 *
 * Transitioning to `'idle'` while the FIFO is non-empty drains ONE payload
 * via `onSubmit` (oldest first) — the "stream ended, your queued message just
 * auto-submitted" path. Each subsequent turn's end drains the next, so N
 * queued messages run as N sequential turns.
 *
 * `'idle' → 'streaming'` is a no-op transition (no flush).
 */
export type CompositorInputMode = 'idle' | 'streaming' | 'picker';

/**
 * Picker controller — supplied by `enterPickerMode()` to delegate
 * rendering and keystroke handling to a transient overlay.
 *
 * Invariant: while a picker is active (`inputMode === 'picker'`),
 * the compositor stops rendering its own input/buffer/dropdown rows
 * and ALL keystrokes are forwarded to `onKey`. The picker decides
 * what each keystroke means (Up/Down/Space/Enter/Escape, etc.) and
 * calls `repaintPicker()` on the compositor when its state changes.
 *
 * Contract:
 * - `renderRows()` returns the full set of lines the picker wants
 *   rendered in the input region. The compositor stacks them above
 *   the bottom row, replacing what would otherwise be the input
 *   line + dropdown + hint. Order: top of frame → bottom row.
 * - `onKey(char, key)` receives every raw keystroke. The picker is
 *   responsible for cancellation (Esc/Ctrl+C) and confirmation
 *   (Enter); the compositor never short-circuits these in picker
 *   mode. To exit, the picker calls `compositor.exitPickerMode()`.
 */
export interface PickerController {
  renderRows: () => readonly string[];
  onKey: (char: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string }) => void;
}

/**
 * Payload delivered to {@link TerminalCompositorOptions.onSubmit}.
 * Text + attachment array; mirrors the
 * {@link ./input/types.js#ReadWithAutocompleteResult} shape so callers
 * that migrate from `readWithAutocomplete` to the persistent
 * compositor can swap the data source without touching downstream
 * code that processes the submission.
 *
 * `text` is the canonical submission body — the string sent to the
 * model. When a bracketed paste was truncated into a placeholder, the
 * placeholder has been expanded back to the full pasted content in
 * `text`.
 *
 * `displayText` is the placeholder-preserving variant intended for the
 * scrollback echo. Only present when truncation actually happened;
 * absent on submissions that round-tripped without any paste
 * placeholders. Callers that don't differentiate (and the existing
 * majority that just want a single string) can use
 * `payload.displayText ?? payload.text`.
 */
export interface SubmissionPayload {
  text: string;
  displayText?: string;
  attachments: readonly ImageAttachment[];
}

export interface TerminalCompositorOptions {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  /**
   * Fires on ESC (streaming mode only) or Ctrl+C (any mode).
   *
   * Mode-dependent dispatch — see {@link CompositorInputMode}:
   *   - In `'streaming'` mode, ESC and Ctrl+C set `canceled = true`
   *     (once-only) + queue the buffer + fire onCancel. Used to
   *     interrupt the agent and capture the typed-but-not-submitted
   *     text as the next turn's seed.
   *   - In `'idle'` mode, only Ctrl+C fires (ESC is reserved for
   *     closing the dropdown). No once-only guard, no buffer queue —
   *     the persistent compositor must remain cancelable across
   *     many idle Ctrl+C presses (e.g. the REPL's
   *     "press Ctrl+C again to quit" affordance). The surface
   *     typically installs `handleSigint` here.
   */
  onCancel?: () => void;
  /**
   * Fires on ESC in `'streaming'` mode as a soft-stop signal — distinct
   * from `onCancel` (Ctrl+C / hard-abort path). Once-only per turn: a
   * second ESC press while streaming is ignored (guard `softStopped`).
   *
   * Semantics:
   *   - Halts the provider event stream cleanly (caller calls
   *     `session.interrupt()`).
   *   - Preserves already-completed tool calls in session state.
   *   - Renders "Stopped — work so far kept." via the compositor.
   *   - Does NOT set `canceled` — the turn is recoverable; next Enter
   *     starts a new turn in the same session.
   *
   * ESC in `'idle'` mode is NOT routed here — in idle, ESC only dismisses
   * the autocomplete dropdown (no-op if dropdown is closed).
   */
  onSoftStop?: () => void;
  onBackground?: () => void;
  /**
   * Fires on Shift+Tab. Replaces the historical reader.ts onShiftTab
   * binding (plan-mode toggle) so the persistent compositor offers
   * the same gesture across both idle and streaming phases.
   */
  onShiftTab?: () => void;
  /**
   * One-shot submission handler invoked when a message "submits" —
   * either immediately on Enter in `'idle'` mode, or deferred until
   * the mode transitions to `'idle'` (draining one queued payload,
   * oldest first) in `'streaming'` mode.
   *
   * Receives the text buffer plus any clipboard image attachments
   * collected via bracketed-paste / Ctrl+V during the submission's
   * compose window. Attachments are passed BY VALUE (frozen array
   * copy) so the handler can persist them past the compositor's
   * synchronous clear.
   *
   * Optional — when omitted, streaming-mode Enter still commits to the
   * pending-submission FIFO (observable via {@link getPendingCount} and the
   * `queued` flag from {@link getBuffer}), but nothing drains, since draining
   * requires a handler. The existing arm/disarm-per-turn callers in the repo
   * do not set this; only the persistent InputSurface installs it.
   */
  onSubmit?: (payload: SubmissionPayload) => void;
  /**
   * Prompt prefix rendered at the start of the input row.
   *
   * Accepts either:
   *   - a `string` — fixed for the compositor's lifetime (per-turn callers
   *     use this; the prompt only changes between turns and they
   *     reconstruct the compositor anyway).
   *   - a `() => string` — re-queried on every {@link renderInputLine}
   *     call so plan-mode toggles, model swaps, and other between-turn
   *     state changes reflect immediately. The persistent InputSurface
   *     (Stage 3b+) passes a closure so its single long-lived
   *     compositor tracks the canonical prompt across all turns.
   *
   * Falsy / unset → dim chevron fallback (`'  ⎯ '`).
   */
  promptText?: string | (() => string);
  /**
   * When provided, ↑/Ctrl+P and ↓/Ctrl+N navigate history during the
   * agent turn, consistent with the between-turn prompt surface.
   */
  history?: IHistoryRing;
  /**
   * When provided, the compositor reads/writes this shared autocomplete
   * state so the dropdown is consistent across user-turn and agent-turn.
   * On each printable keypress the compositor re-derives candidates from
   * the current buffer and renders them inside the log-update frame below
   * the input row.
   */
  autocompleteState?: AutocompleteState;
  /**
   * When provided, the compositor passes pre-cursor and post-cursor
   * substrings of the input buffer through this function before rendering
   * the input line. Lets callers wire `colorizeInputBuffer(...)` (or any
   * other transformation) without coupling the compositor to the slash
   * registry or the colorizer module.
   *
   * The caret-position substring is rendered as an inverse-video block
   * separately and is NOT passed through this function — a slash token
   * straddling the cursor will not colorize until the cursor moves past
   * its tail. Matches the architect-pattern callback the user-turn render
   * path could reuse if it were ever rewritten on top of log-update.
   */
  formatInputBuffer?: (segment: string) => string;
  /**
   * When provided, `commitAbove` wraps its raw `stdout.write(text + '\n')`
   * in `scrollRegion.withFullScrollRegion(...)` so the scrollback-bound
   * write happens under full-screen scroll semantics instead of inside
   * the StatusLine's DECSTBM sub-region (which would silently drop
   * displaced lines on xterm/iTerm2/Apple Terminal).
   */
  scrollRegion?: CompositorScrollRegionGuard;
  /**
   * When true, suppress the spinner repaint loop (and any other
   * timer-driven repainter that would write to stdout in the background).
   * Used when stdout is being recorded by `script(1)` / `asciinema` and the
   * cursor-up + erase-line escapes from log-update survive as visible
   * bytes in the captured artifact. See `_lib/capture-mode.ts` for the
   * detection contract.
   *
   * Does NOT change the input-handling, scrollback-commit, or
   * state-transition-driven overlay paths — only the spinner ticker.
   * Default `false` (live-TTY behavior unchanged).
   */
  captureMode?: boolean;
  /**
   * Upper-bound row protection for the live frame. When set, the compositor
   * treats rows `1..anchorRow-1` as containing pre-arm scrollback content
   * (welcome banner, update-notice, etc.) that must NOT be overwritten by
   * the CUP-positioned frame. When the frame would otherwise grow above
   * `anchorRow`, `repaint` evicts the deficit number of rows into terminal
   * scrollback (via DECSTBM-region `\n` writes) BEFORE rendering, and
   * shifts `anchorRow` upward to track the new safe ceiling.
   *
   * When omitted, behavior matches pre-fix semantics — frame is free to
   * grow up to row 1, overwriting whatever was painted above by callers
   * that bypassed `commitAbove` (e.g. raw `console.log` welcome banner).
   * Set by callers (`InputSurface.armCompositor`) that know what they
   * printed before arming.
   *
   * Mutable post-construction via {@link TerminalCompositor.setAnchorRow}.
   */
  anchorRow?: number;
  /**
   * When provided, the compositor wires in ghost-text (fish-shell-style
   * inline completion) for the input line.
   *
   * `engine` — a `SuggestEngine` (create with `createSuggestEngine()`).
   * The compositor calls `engine.getDeterministicGhost` synchronously on
   * every keystroke and `engine.getGhost` fire-and-forget for async Tier-2
   * suggestions. The engine is disposed in `disarm()`.
   *
   * `getContext` — a closure that returns the current `SuggestContext`
   * (model, cwd, history, etc.) re-evaluated at suggestion time. Keeps the
   * compositor decoupled from any specific config module — it only calls
   * `engine` methods and reads the injected context.
   *
   * When omitted (the default), ghost text is entirely disabled —
   * no new behaviour compared to before this field existed.
   */
  suggest?: {
    engine: SuggestEngine;
    getContext: () => SuggestContext;
  };
}
