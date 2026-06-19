/**
 * InputSurface — long-lived REPL input abstraction.
 *
 * Owns the buffer-independent state that lives across turns: the history
 * ring (↑/↓ recall), the shared autocomplete dropdown state, the
 * StatusLine ref for DECSTBM coordination, and the readline interface.
 *
 * Replaces the previous pattern where `repl-loop.ts` held these as
 * separate locals and re-passed them to `readWithAutocomplete` (between
 * turns) and to `runTurn` (during turn) by hand. One object, one
 * lifetime, one source of truth.
 *
 * ## Stage 2 (this commit) — facade only
 *
 * `readLine()` delegates to the existing `readWithAutocomplete` so the
 * between-turn input UX is byte-identical. The agent-turn surface
 * (TerminalCompositor) is still constructed per-turn by StreamRenderer,
 * which reaches back into this surface for its history + autocompleteState
 * refs via {@link InputSurface.toRunTurnRefs}.
 *
 * ## Stage 3 (next) — persistent compositor
 *
 * The InputSurface will own a single long-lived TerminalCompositor that
 * stays armed across the turn boundary. `readLine()` will block on an
 * Enter submission from that compositor instead of calling the
 * disarm/rearm cycle's reader. The `compositor` option on
 * {@link InputSurfaceReadOpts} is already plumbed in anticipation of that
 * — the existing defensive guard at `reader.ts:51` (skip raw-mode entry
 * when an external compositor is armed) becomes load-bearing then.
 *
 * @module cli/input/input-surface
 */

import type { Interface as ReadlineInterface } from 'readline';
import { readWithAutocomplete } from '../input-box.js';
import {
  createAutocompleteState,
  type AutocompleteState,
} from './autocomplete-state.js';
import type {
  IHistoryRing,
  ReadWithAutocompleteResult,
} from './types.js';
import {
  TerminalCompositor,
  type CompositorScrollRegionGuard,
  type SubmissionPayload,
  type SuggestEngine,
  type SuggestContext,
} from '../terminal-compositor.js';
import { colorizeInputBuffer, type SlashRegistryView } from '../input-highlight.js';
import { list as listSlashCommands } from '../slash/registry.js';
import { formatSubmittedEcho } from './echo.js';
import { describeAttachmentSummary } from './attachments.js';

/**
 * Minimal StatusLine surface used by InputSurface — kept structural
 * (not a class import) so input-surface.ts stays cycle-safe and so
 * tests can supply a mock without constructing the real StatusLine.
 */
export interface InputSurfaceStatusLine {
  getExtraRows(): number;
  setExtraRows(n: number): void;
  withFullScrollRegion?<T>(fn: () => T): T;
}

export interface InputSurfaceOptions {
  rl: ReadlineInterface;
  /**
   * Pre-loaded history ring. The REPL loads this asynchronously at
   * bootstrap (`loadHistory()`) before constructing the surface so the
   * first readLine() call has full history available — disk I/O must
   * complete before the first prompt (ordered-operation invariant
   * mirrored from the previous inline implementation).
   */
  history: IHistoryRing;
  /**
   * StatusLine ref for DECSTBM coordination. When provided, the
   * reader reserves the bottom row via `setExtraRows(prior + 1)` and
   * routes the submit echo through `withFullScrollRegion(...)` so
   * scrollback survives the persistent sub-region.
   */
  statusLine?: InputSurfaceStatusLine;
}

export interface InputSurfaceReadOpts {
  promptFn: () => string;
  onSigint?: () => void;
  onShiftTab?: () => void;
  /**
   * Currently-armed agent-turn compositor (if any). Today: always
   * `undefined` between turns because the compositor disarms at
   * end-of-turn. Forwarded to the underlying reader as a defensive
   * guard for Stage 3 (persistent compositor), where the reader needs
   * to skip its own raw-mode setup because the surface already owns
   * the bottom row.
   */
  compositor?: TerminalCompositor;
}

/**
 * Refs bag passed FROM the surface TO `runTurn` so the per-turn
 * StreamRenderer/TerminalCompositor share the same history +
 * autocomplete state as the between-turn reader.
 *
 * `promptText` is supplied per-turn by the caller (not stored on the
 * surface) because it depends on the current `model + permissionMode` at
 * turn start, and the StreamRenderer is reconstructed per-turn anyway
 * — the string's lifetime matches the renderer's.
 */
export interface InputSurfaceRefs {
  history?: IHistoryRing;
  autocompleteState?: AutocompleteState;
  promptText?: string;
}

/**
 * Options for {@link InputSurface.armCompositor} — arms a persistent
 * TerminalCompositor that lives across turns. Stable refs (set once
 * at arm time); per-turn callbacks are swapped via setOnBackground.
 */
export interface InputSurfaceArmOpts {
  /**
   * Re-queried on every input-row render so plan-mode toggles +
   * model swaps reflect immediately. Forwarded to the compositor
   * as its `promptText` getter.
   */
  promptFn: () => string;
  /**
   * Stable cancel handler — called when the user presses Ctrl+C in
   * any mode. The REPL passes its `handleSigint` here; that function
   * checks `turnState.turnInFlight` internally to dispatch
   * interrupt-vs-quit appropriately.
   */
  onCancel: () => void;
  /**
   * Stable Shift+Tab handler — typically wired to the plan-mode
   * toggle. Fires in both idle and streaming modes since plan
   * mode is REPL-global.
   */
  onShiftTab?: () => void;
  /**
   * Optional DECSTBM scroll-region guard (typically the active
   * StatusLine). Forwarded to the compositor so `commitAbove`'s
   * scrollback writes use full-screen scroll semantics.
   */
  scrollRegion?: CompositorScrollRegionGuard;
  /**
   * Stream injection for testability + future remote-terminal use
   * (SSH, embedded REPL). Defaults to `process.stdout` / `process.stdin`
   * when omitted. Both must be TTYs for armCompositor to proceed —
   * non-TTY check still applies whether streams are injected or
   * defaulted.
   */
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /**
   * Pre-arm scrollback anchor row — see
   * {@link import('../terminal-compositor.js').TerminalCompositorOptions.anchorRow}.
   * The interactive REPL bootstrap computes this by tallying the rows
   * its banner + boot notices consumed on the cleared viewport, so the
   * compositor's frame can't grow upward to overwrite them. Forwarded
   * verbatim to the underlying TerminalCompositor.
   */
  anchorRow?: number;
  /**
   * Optional ghost-text suggestion engine. When provided, the compositor
   * renders fish-shell-style inline completions. The engine is disposed
   * when the compositor is disarmed.
   *
   * Pass `{ engine, getContext }` where `getContext` returns a fresh
   * `SuggestContext` on each call (model, cwd, history, etc.). The
   * compositor never holds config directly — it reads what the context
   * closure provides. See `TerminalCompositorOptions.suggest`.
   */
  suggest?: {
    engine: SuggestEngine;
    getContext: () => SuggestContext;
  };
}

export class InputSurface {
  readonly history: IHistoryRing;
  readonly autocompleteState: AutocompleteState;
  private readonly rl: ReadlineInterface;
  private readonly statusLine: InputSurfaceStatusLine | undefined;

  /**
   * Persistent compositor — armed once at REPL startup, disarmed at
   * REPL exit. Null until {@link armCompositor} runs (or on non-TTY
   * surfaces that never call it). Surfaced via {@link getCompositor}
   * for borrowing by the per-turn StreamRenderer.
   */
  private compositor: TerminalCompositor | null = null;

  /**
   * Stdout used by the persistent compositor — captured at arm time
   * so {@link readLine}'s submit-echo can derive isTTY from the same
   * stream the compositor renders to. Falls back to process.stdout
   * pre-arm. Cleared in {@link dispose}.
   */
  private armedStdout: NodeJS.WriteStream | null = null;

  /**
   * Mutable background-handler ref. The compositor's `onBackground`
   * closure dereferences this on every Ctrl+B press, so the per-turn
   * `turn-handler.ts` can swap behavior without reconstructing the
   * compositor. Cleared (null) between turns — Ctrl+B has no
   * meaningful idle-mode semantics, and the compositor's mode gate
   * already drops it in idle anyway.
   */
  private backgroundHandler: (() => void) | null = null;

  /**
   * Mutable soft-stop handler ref. The compositor's `onSoftStop`
   * closure dereferences this on every ESC press in streaming mode,
   * so the per-turn `turn-handler.ts` can install its
   * `softStopRequested = true` setter without reconstructing the
   * compositor. Cleared (null) between turns — ESC in idle mode is
   * already a no-op inside the compositor (dispatched to the dropdown-
   * dismiss branch or returned early before the softStopped guard).
   */
  private softStopHandler: (() => void) | null = null;

  /**
   * Mutable pause-interrupt handler ref. The compositor's `onPauseInterrupt`
   * closure dereferences this when the user submits a line during a
   * usage-limit pause (compositor `paused === true`), so the per-turn
   * `turn-handler.ts` can install its `session.interrupt()` closure without
   * reconstructing the compositor. Cleared (null) between turns.
   */
  private pauseInterruptHandler: (() => void) | null = null;

  /**
   * Reject callback for the currently-pending readLine Promise (if any).
   * Set inside `readLine()` before the compositor path blocks, and
   * cleared once the Promise settles. Used by `dispose()` to abort any
   * in-flight read so the Promise does not hang permanently after the
   * compositor has been disarmed.
   */
  private pendingReadReject: ((reason: Error) => void) | null = null;

  /**
   * Live-registry adapter — queried fresh via `listSlashCommands()` on
   * every call so plugins that register slash commands mid-session
   * colorize correctly. Held as a class field (not an `armCompositor`
   * local) because two call sites need it: the compositor's
   * `formatInputBuffer` live-typing hook AND the `readLine` submit-echo
   * which must colorize `payload.text` before committing to scrollback
   * — without that second call, the submitted slash command appears as
   * plain text in history (parity bug vs. `reader.ts:329-330`).
   */
  private readonly slashRegistryView: SlashRegistryView = {
    has: (name) => listSlashCommands().some((c) => c.name === `/${name}`),
  };

  constructor(opts: InputSurfaceOptions) {
    this.rl = opts.rl;
    this.history = opts.history;
    this.statusLine = opts.statusLine;
    // One AutocompleteState per surface — shared by between-turn reads
    // (this.readLine) and agent-turn renders (TerminalCompositor, via
    // the refs handed to StreamRenderer through toRunTurnRefs).
    this.autocompleteState = createAutocompleteState();
  }

  /**
   * Arm a persistent TerminalCompositor in idle mode. Idempotent —
   * subsequent calls are no-ops. Skipped silently on non-TTY surfaces
   * (no `process.stdout.isTTY`); callers can detect this via
   * {@link getCompositor} returning null.
   */
  async armCompositor(opts: InputSurfaceArmOpts): Promise<void> {
    if (this.compositor) return;
    const stdout = opts.stdout ?? process.stdout;
    const stdin = opts.stdin ?? process.stdin;
    if (!stdout.isTTY || !stdin.isTTY) return;
    const compositor = new TerminalCompositor({
      stdout,
      stdin,
      // Dynamic — re-queried on every render so the bottom-row prompt
      // tracks plan-mode / model toggles without compositor restart.
      promptText: opts.promptFn,
      // Stable cancel handler. Mode-aware behavior (queue+canceled
      // flag in streaming, plain dispatch in idle) lives inside the
      // compositor; the surface just supplies the closure.
      onCancel: opts.onCancel,
      // Soft-stop handler is mutable — close over the surface's ref so
      // per-turn swaps via this.softStopHandler take effect immediately
      // without reconstructing the compositor. The compositor's
      // `softStopped` once-only guard handles idempotency per-turn.
      onSoftStop: () => { this.softStopHandler?.(); },
      // Background handler is mutable — close over the surface's ref
      // so per-turn swaps via this.backgroundHandler take effect
      // immediately.
      onBackground: () => { this.backgroundHandler?.(); },
      // Pause-interrupt handler is mutable — close over the surface's ref so
      // the per-turn turn-handler swap takes effect immediately. Fires when
      // the user submits a line during a usage-limit pause.
      onPauseInterrupt: () => { this.pauseInterruptHandler?.(); },
      ...(opts.onShiftTab ? { onShiftTab: opts.onShiftTab } : {}),
      history: this.history,
      autocompleteState: this.autocompleteState,
      formatInputBuffer: (segment) => colorizeInputBuffer(segment, this.slashRegistryView),
      ...(opts.scrollRegion ? { scrollRegion: opts.scrollRegion } : {}),
      ...(opts.anchorRow !== undefined ? { anchorRow: opts.anchorRow } : {}),
      ...(opts.suggest ? { suggest: opts.suggest } : {}),
    });
    await compositor.arm();
    compositor.setInputMode('idle');
    this.compositor = compositor;
    this.armedStdout = stdout;
  }

  /**
   * Disarm and dispose the persistent compositor. Idempotent.
   * Call on REPL exit (and surface goodbye-banner before this so the
   * banner commits above a still-armed compositor instead of into
   * raw stdout after disarm).
   *
   * If a `readLine()` Promise is in-flight when `dispose()` is called,
   * the pending Promise is rejected with a `DisposedError` — this
   * prevents it from hanging permanently after the compositor is
   * disarmed and can no longer deliver a keypress submission.
   */
  async dispose(): Promise<void> {
    if (!this.compositor) return;
    // Abort any in-flight readLine before disarming. Clear the onSubmit
    // handler first so the reject callback fires cleanly (no stale
    // handler would call resolve after we've already rejected).
    if (this.pendingReadReject) {
      this.compositor.setOnSubmit(null);
      const reject = this.pendingReadReject;
      this.pendingReadReject = null;
      reject(new Error('InputSurface disposed while readLine was in progress'));
    }
    try { this.compositor.disarm(); } catch { /* best effort */ }
    this.compositor = null;
    this.armedStdout = null;
    this.backgroundHandler = null;
    this.softStopHandler = null;
    this.pauseInterruptHandler = null;
  }

  /**
   * Compositor accessor for per-turn borrowing — the StreamRenderer's
   * `compositor` option threads this through and the renderer
   * treats the borrowed compositor as a non-owned resource (no
   * disarm at dispose). Returns null if not yet armed or non-TTY.
   */
  getCompositor(): TerminalCompositor | null {
    return this.compositor;
  }

  /**
   * Install or clear the Ctrl+B background handler. Per-turn —
   * `turn-handler.ts` sets a closure that flips `backgroundRequested`
   * at turn start and clears with `null` at turn end.
   */
  setBackgroundHandler(handler: (() => void) | null): void {
    this.backgroundHandler = handler;
  }

  /**
  /**
   * Install or clear the ESC soft-stop handler. Per-turn —
   * `turn-handler.ts` sets a closure that flips `softStopRequested`
   * at turn start and clears with `null` at turn end so ESC between
   * turns is a no-op (compositor mode gate drops it in idle anyway,
   * but defense in depth).
   */
  setSoftStopHandler(handler: (() => void) | null): void {
    this.softStopHandler = handler;
  }

  /**
   * Install or clear the per-turn pause-interrupt handler. The compositor's
   * `onPauseInterrupt` closure dereferences this ref, so swapping it here
   * takes effect immediately without reconstructing the compositor. Wired by
   * the REPL to the turn handler's `session.interrupt()` closure; cleared at
   * turn end. No-op (benign null-ref mutation) when no compositor is armed.
   */
  setPauseInterruptHandler(handler: (() => void) | null): void {
    this.pauseInterruptHandler = handler;
  }

  /**
   * Toggle the compositor's `paused` flag — set true while a usage-limit
   * pause is parked so a submitted line fires {@link setPauseInterruptHandler}.
   * No-op when no compositor is armed (non-TTY).
   */
  setPausedState(paused: boolean): void {
    if (this.compositor) this.compositor.paused = paused;
  }

  /**
   * Temporarily yield stdin raw-mode and the keypress listener to an
   * external readline caller (e.g. the elicitation `rl.question` path).
   * No-op when no compositor is armed. Pair every call with
   * `resumeAfterElicitation()`.
   */
  suspendForElicitation(): void {
    this.compositor?.suspendInput();
  }

  /**
   * Restore raw-mode and the keypress listener after a
   * `suspendForElicitation()` call. No-op when no compositor is armed.
   */
  resumeAfterElicitation(): void {
    this.compositor?.resumeInput();
  }

  /**
   * Block until the user submits a line via Enter.
   *
   * Two paths:
   *   1. Persistent compositor armed → install a one-shot onSubmit
   *      handler, flip the compositor to `'idle'` mode (which also
   *      flushes any queued submission from a just-ended streaming
   *      turn), await the resolution.
   *   2. No compositor (non-TTY tests, surfaces that don't arm) →
   *      delegate to the existing `readWithAutocomplete` reader.
   */
  async readLine(opts: InputSurfaceReadOpts): Promise<ReadWithAutocompleteResult> {
    if (this.compositor && this.compositor.isArmed()) {
      const compositor = this.compositor;
      return new Promise<ReadWithAutocompleteResult>((resolve, reject) => {
        // Store the reject so dispose() can abort this Promise if
        // the surface is torn down before the user presses Enter.
        this.pendingReadReject = reject;

        const handler = (payload: SubmissionPayload) => {
          // One-shot: clear the handler after fire so the next
          // readLine() call wires a fresh resolver. Reading
          // `onSubmit` via the setter (not direct field access)
          // keeps the compositor's invariant that submission state
          // is cleared BEFORE the handler runs intact.
          compositor.setOnSubmit(null);
          // Settled — clear the dispose-abort ref so a subsequent
          // dispose() doesn't try to reject an already-resolved Promise.
          this.pendingReadReject = null;

          // Visual parity with `readWithAutocomplete`: commit the
          // submitted message to scrollback above the live overlay.
          // Without this echo the user's typed text vanishes the
          // instant Enter clears the input row, leaving a one-sided
          // transcript when scrolling back through history.
          //
          // commitAbove handles the DECSTBM scroll-region dance so
          // the echo survives the persistent statusline at the
          // bottom — same external constraint as reader.ts:341
          // routes through statusLine.withFullScrollRegion.
          // Derive isTTY from the stream the compositor renders to —
          // matches when the surface is armed against injected streams
          // (tests, future remote-terminal) instead of process.stdout.
          const echoStdout = this.armedStdout ?? process.stdout;
          // Colorize the submitted buffer before committing to scrollback
          // so slash commands (e.g. `/checkpoint`) keep their highlight in
          // history — mirrors reader.ts:329-330. The compositor's
          // SubmissionPayload.text is the raw uncolored buffer string;
          // without this call the scrollback echo renders as plain text
          // even though live-typing was colorized via formatInputBuffer.
          //
          // Use `displayText` when the compositor signaled that the
          // submission had a placeholder representation (large paste
          // truncated into `[Pasted text #N +M lines]`). The echo
          // keeps the placeholder so scrollback stays compact; the
          // full content is already on its way to the model via
          // `payload.text`. Falls back to `payload.text` for
          // submissions that round-tripped without any truncation.
          const echoText = payload.displayText ?? payload.text;
          const echo = formatSubmittedEcho({
            buffer: colorizeInputBuffer(echoText, this.slashRegistryView),
            promptText: opts.promptFn(),
            isTTY: Boolean(echoStdout.isTTY),
            attachmentSummary: describeAttachmentSummary([...payload.attachments]),
          });
          // formatSubmittedEcho can return multi-line strings (long
          // input is rendered as a card with `\n` between rows).
          // commitAbove expects one logical line per call — split so
          // each row commits as its own scrollback entry.
          for (const line of echo.split('\n')) {
            compositor.commitAbove(line);
          }

          resolve({ text: payload.text, attachments: [...payload.attachments] });
        };
        compositor.setOnSubmit(handler);
        // Flip to idle mode. Side effects:
        //   1. The turn-handler's renderer.dispose() already flipped
        //      to idle and may have left a queued buffer (user typed
        //      + Entered mid-stream); the widened setInputMode flush
        //      invariant — any → idle with queued + handler — fires
        //      the synthesized submission immediately so the queued
        //      payload auto-submits as the next turn (option (b)).
        //   2. If we're already in idle with no queue it records the
        //      mode but does NOT repaint (the prev!==mode guard at
        //      terminal-compositor.ts suppresses idle→idle repaints).
        compositor.setInputMode('idle');
        // Invariant: the prompt must be on-screen before we block for
        // input. setInputMode('idle') above does not repaint on an
        // idle→idle transition (see (2)), and footer subsystems
        // (loop-stage bar, bg bar) bump extraRows AFTER armCompositor's
        // initial paint — overwriting the prompt row. Repaint here so a
        // fresh interactive session shows the prompt immediately rather
        // than only after the first keypress. Idle repaint is one cheap
        // frame; redundant if the prompt was already correctly drawn.
        compositor.repaint();
      });
    }
    // Non-TTY fallback: delegate to the existing reader.
    return readWithAutocomplete({
      rl: this.rl,
      promptFn: opts.promptFn,
      ...(opts.onSigint ? { onSigint: opts.onSigint } : {}),
      ...(opts.onShiftTab ? { onShiftTab: opts.onShiftTab } : {}),
      ...(opts.compositor ? { compositor: opts.compositor } : {}),
      history: this.history,
      autocompleteState: this.autocompleteState,
      ...(this.statusLine ? { statusLine: this.statusLine } : {}),
    });
  }

  /**
   * Build the refs bag passed to `runTurn` via the `inputSurface`
   * parameter. The promptText is supplied by the caller because it
   * depends on the current model + permissionMode at turn start.
   */
  toRunTurnRefs(promptText: string): InputSurfaceRefs {
    return {
      history: this.history,
      autocompleteState: this.autocompleteState,
      promptText,
    };
  }
}
