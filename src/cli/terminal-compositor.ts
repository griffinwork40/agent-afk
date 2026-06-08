/**
 * TerminalCompositor
 *
 * Orchestrates the terminal while an agent turn is streaming. Owns a single
 * `log-update` instance and renders one frame per repaint: an optional
 * overlay (live in-progress markdown) followed by a persistent input line
 * at the bottom. Committed blocks are written to stdout above the log-update
 * region so they scroll normally.
 *
 * Lifecycle: construct → arm() before a turn → setOverlay/commitAbove as the
 * stream produces events → disarm() in finally. Between arm and disarm the
 * compositor holds raw mode + a keypress listener. ESC or Ctrl+C fires
 * onCancel once; Enter on a non-empty buffer flips `queued=true`; Backspace
 * and printable characters edit the buffer and clear the queued flag so
 * further editing unqueues cleanly.
 */

import { emitKeypressEventsImmediateEscape } from './input/emit-keypress.js';
import { env } from '../config/env.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { palette } from './palette.js';
import { ResizeBus } from './terminal-size.js';
import { InputCore, type InputCoreState } from './input-core.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { IHistoryRing } from './input/types.js';
import { renderStatusLine, type ImageAttachment } from './input/attachments.js';
import { SpinnerController } from './input/spinner.js';
import {
  acquireStdinClaim,
  type StdinClaimHandle,
} from './input/stdin-claim.js';
import {
  type CompositorInputMode,
  type CompositorScrollRegionGuard,
  type KeyInfo,
  type LogUpdateFn,
  type PickerController,
  type SubmissionPayload,
  type TerminalCompositorOptions,
  type SuggestEngine,
  type SuggestContext,
} from './terminal-compositor.types.js';
import * as Paste from './terminal-compositor.paste.js';
import * as Autocomplete from './terminal-compositor.autocomplete.js';
import * as Render from './terminal-compositor.render.js';
import * as CommittedBand from './terminal-compositor.committed-band.js';
import * as InputDispatch from './terminal-compositor.input-dispatch.js';

// Re-export public types so existing importers of './terminal-compositor.js'
// continue to work without any import-path changes.
export type {
  CompositorInputMode,
  CompositorScrollRegionGuard,
  PickerController,
  SubmissionPayload,
  SuggestContext,
  SuggestEngine,
  TerminalCompositorOptions,
};

export class TerminalCompositor {
  /** @internal Relaxed from `private` — read by sibling free-function modules via Host interfaces. */
  readonly stdout: NodeJS.WriteStream;
  private readonly stdin: NodeJS.ReadStream;
  /**
   * Per-turn cancel + background + shift-tab handlers — see
   * {@link TerminalCompositorOptions.onCancel} et al. Mutable so the
   * persistent InputSurface can swap them between turns (e.g.
   * `handleSigint` between turns vs `() => session.interrupt()`
   * mid-turn).
   */
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  onCancel?: () => void;
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  onSoftStop?: () => void;
  /**
   * Once-only guard for the soft-stop path: ESC in streaming mode fires
   * `onSoftStop` exactly once per turn. Reset in `resetState()` and on
   * idle→streaming transition so each new turn can be soft-stopped.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  softStopped = false;
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  onBackground?: () => void;
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  onShiftTab?: () => void;
  /**
   * Resolved prompt accessor. Always a function — strings supplied at
   * construction are wrapped in a constant-returning closure so the
   * downstream code path is uniform.
   */
  /** @internal Relaxed from `private` — read by sibling free-function modules via Host interfaces. */
  readonly promptTextFn: () => string;
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  readonly history?: IHistoryRing;
  /** @internal Relaxed from `private` — read/mutated-in-place by sibling free-function modules via Host interfaces. */
  readonly autocompleteState?: AutocompleteState;
  /** @internal Relaxed from `private` — read by sibling free-function modules via Host interfaces. */
  readonly formatInputBuffer?: (segment: string) => string;
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  readonly scrollRegion?: CompositorScrollRegionGuard;
  /**
   * Working anchor row — see {@link TerminalCompositorOptions.anchorRow}.
   * Mutable because eviction in {@link repaint} shifts it upward as
   * content is pushed into scrollback. Cleared in {@link resetState}
   * so a stale post-eviction value never survives a disarm/rearm cycle
   * on the same instance; the next {@link arm} call restores it from
   * {@link declaredAnchorRow}. `undefined` means "no protection"
   * (legacy behavior — frame can grow up to row 1).
   */
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  anchorRow: number | undefined;
  /**
   * Caller-declared anchor row — the "source of truth" intent captured
   * from the constructor and overwritten by {@link setAnchorRow}. Never
   * mutated by eviction. {@link arm} restores {@link anchorRow} from
   * this value on every (re)arm so the working ceiling starts each
   * lifecycle from the caller's declared intent, not the previous
   * cycle's evicted residue.
   */
  private declaredAnchorRow: number | undefined;

  /**
   * Submission handler — see {@link TerminalCompositorOptions.onSubmit}.
   * Mutable so the InputSurface can install/clear it without
   * reconstructing the compositor.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  onSubmit?: (payload: SubmissionPayload) => void;
  /**
   * Image attachments accumulated via bracketed paste / Ctrl+V during
   * the current compose window. Cleared (alongside `input` + `queued`)
   * whenever {@link onSubmit} fires.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  attachments: ImageAttachment[] = [];
  /**
   * Bracketed-paste state. `pasting` is true while the keystream is
   * between `\x1b[200~` (start) and `\x1b[201~` (end) markers.
   * `pasteStartBufferLen` snapshots the buffer length at paste start
   * so the end marker can detect "zero characters added" — the
   * signature of a Cmd+V on a clipboard whose only payload is image
   * bytes (no text representation). `pasteStartCursor` snapshots the
   * insertion point so the end marker can slice the pasted span out
   * of the buffer and (if it exceeds the truncation thresholds)
   * replace it with a `[Pasted text #N +M lines]` placeholder.
   */
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  pasting = false;
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  pasteStartBufferLen = 0;
  /** @internal Read by the paste module (PasteHost) and the input-dispatch module (KeyDispatchHost). */
  pasteStartCursor = 0;
  /**
   * Side-table for truncated pastes — see the paste module
   * (`terminal-compositor.paste.ts`). When a bracketed paste exceeds the
   * line or char thresholds, the full pasted content is stored here
   * keyed by an auto-incrementing id, and the input buffer keeps only
   * a compact `[Pasted text #N +M lines]` placeholder.
   *
   * Re-expanded on submit (idle-mode Enter, streaming → idle flush,
   * getBuffer()) so the model receives the full text. Cleared on full
   * buffer reset (submit clears + resetState() between arm cycles).
   * Orphaned entries (placeholder deleted by the user) leak only
   * within a single compose window — submit clears the whole table.
   *
   * Each paste gets an opaque 8-hex-char nonce as its key so a user
   * who manually types a `[Pasted text #…]` literal cannot expand
   * real paste content. Reset by `resetState()`.
   *
   * @internal Read/mutated by the paste module (PasteHost).
   */
  pasteRegistry = new Map<string, string>();
  /**
   * Guard against concurrent `osascript` spawns from rapid Ctrl+V /
   * Cmd+V key repeats. Ported from `reader.ts` — a single in-flight
   * clipboard read is sufficient; subsequent presses are dropped
   * until the active probe completes.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  clipboardInFlight = false;
  /**
   * Paint-clear status line surfaced when a clipboard probe found no
   * image. Shown above the input row exactly once; consumed (cleared)
   * on the next repaint so the message disappears as soon as the
   * user does anything.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  clipboardFailureMsg: string | null = null;
  /**
   * Input mode — see {@link CompositorInputMode}. Default `'streaming'`
   * matches the historical single-mode behavior all existing callers
   * (turn-handler, tests) rely on; only the persistent InputSurface
   * flips to `'idle'` explicitly.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  inputMode: CompositorInputMode = 'streaming';
  /**
   * Active picker controller — non-null IFF `inputMode === 'picker'`.
   * Set by `enterPickerMode()`, cleared by `exitPickerMode()`. While
   * non-null, the compositor's input/buffer/dropdown rendering is
   * suppressed and all keystrokes route to `pickerController.onKey`.
   *
   * Invariant: `inputMode === 'picker'` ⇔ `pickerController !== null`.
   * Both are flipped together inside `enterPickerMode`/`exitPickerMode`
   * so no caller can observe one without the other.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  pickerController: PickerController | null = null;
  /**
   * Saved input mode at the moment `enterPickerMode()` was called.
   * Restored by `exitPickerMode()` so picker-mode is a transparent
   * borrow of the input region (no permanent mode change).
   */
  private pickerSavedMode: CompositorInputMode = 'streaming';

  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  armed = false;
  private suspended = false;  // true while suspendInput() is in effect
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  canceled = false;
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  backgrounded = false;
  private wasRaw = false;
  /** Held while armed; released on disarm(). */
  private stdinClaim: StdinClaimHandle | null = null;
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  logUpdate: LogUpdateFn | null = null;

  private overlay = '';
  /** @internal Relaxed from `private` — read/written by sibling free-function modules via Host interfaces. */
  input: InputCoreState = InputCore.seed('');
  /** @internal Relaxed from `private` — read/written by sibling free-function modules via Host interfaces. */
  queued = false;

  private handleKeypress: ((char: string | undefined, key: KeyInfo) => void) | null = null;
  private resizeUnsub: (() => void) | null = null;
  private resizeImmediateUnsub: (() => void) | null = null;

  private readonly spinnerController: SpinnerController;
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  committing = false;
  /**
   * Set to `true` by `commitAbove` when a block is successfully committed
   * during the current arm cycle. Guards `growthDeficit` in `repaint()` so
   * evict-on-growth only fires when there IS committed transcript content
   * above the frame to protect. Without this gate the initial arm repaint
   * would set `prevTopRow` and then ANY frame growth (spinner appearing,
   * first overlay line) would trigger eviction of blank viewport rows,
   * jumping the user's transcript up on every chrome change. Reset by
   * `resetState()` so each arm cycle starts clean.
   */
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  hasCommitted = false;

  // History: the committed-band re-pin closes the "weird gap" residual of PR
  // #557 — committed text painted above a tall frame was orphaned when the frame
  // collapsed beneath it. Full root-cause + design: docs/scrollback.md
  // ("Fixed: shrink gap (committed-band re-pin)").
  //
  // Invariant: committedBand is non-empty ONLY while committed content is
  // displayed in-viewport between `anchorRow` and the live frame top. It holds
  // the FULL contiguous on-screen committed run (not just the latest block) so
  // a collapse re-pins all of it adjacent to the frame. Set by commitAbove
  // Phase 3 (which merges the prior band with each new block); rows shifted on
  // evict-on-growth; capped at the anchor-floor→frame room and cleared once it
  // scrolls past the anchor floor and by resetState(). On SIGWINCH the band
  // content is PRESERVED (not cleared) so repositionCommittedBand() can re-pin
  // it at the new geometry; the old on-screen copy is erased via
  // pendingResizeErase (expand) or scrolled by the terminal (shrink). Rows are
  // 1-based screen positions; 0 means "unset". See repositionCommittedBand().
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  committedBand: string[] = [];
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  committedBandTopRow = 0;
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  committedBandBottomRow = 0;

  // Resize ghost-erase state. On SIGWINCH the immediate handler snapshots the
  // pre-resize on-screen footprint of the compositor (old live-frame rows +
  // committed-band rows) into `pendingResizeErase`; the next repaint physically
  // erases that band before painting the new geometry (see flushResizeGhostErase
  // and repaint()). `lastKnownRows` is the `stdout.rows` value as of the last
  // paint — it lets the handler tell an EXPAND (terminal freezes existing
  // content at its old absolute rows and opens blank rows below, orphaning the
  // old frame/band as ghosts) from a SHRINK (terminal scrolls content up, so
  // those absolute rows now address reflowed content and must NOT be erased).
  // Both are 1-based screen rows; reset on disarm via resetState().
  private lastKnownRows = 0;
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  pendingResizeErase: { top: number; bottom: number } | null = null;
  // True for the full duration of commitAbove (Phases 1–3). Suppresses the
  // shrink re-pin during the Phase-2 repaint — Phase 3 paints the band itself
  // and sets its rows, so re-pinning mid-commit would act on a stale band.
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  commitInFlight = false;

  private readonly debugCompositor: boolean = !!env.AFK_DEBUG_COMPOSITOR;

  // ── Ghost-text (inline suggestion) state ────────────────────────────────
  //
  // Invariant: `ghostEngine` and `ghostGetContext` are either both set or
  // both absent — they are populated together from `opts.suggest` in the
  // constructor and never mutated after that. `activeGhost` holds the most
  // recent suggestion accepted as display-ready; it is cleared whenever the
  // buffer changes in a way that would make the suggestion stale (no longer
  // a strict prefix of the new buffer) and populated asynchronously on
  // async Tier-2 resolve (guarded by buffer-identity check to prevent stale
  // renders). Both are cleared on disarm/resetState.
  /** @internal Relaxed from `private` — read by sibling free-function modules via Host interfaces. */
  readonly ghostEngine: SuggestEngine | undefined;
  /** @internal Relaxed from `private` — read by sibling free-function modules via Host interfaces. */
  readonly ghostGetContext: (() => SuggestContext) | undefined;
  /**
   * Currently active ghost string (the FULL candidate — buffer is a prefix of it).
   * @internal Relaxed from `private` — read/written by sibling free-function modules via Host interfaces.
   */
  activeGhost: string | null = null;

  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  debugLog(stage: string, extra: Record<string, unknown> = {}): void {
    if (!this.debugCompositor) return;
    const t = process.hrtime.bigint();
    const kv = Object.entries(extra)
      .map(([k, v]) => {
        const s = typeof v === 'string' ? JSON.stringify(v.length > 60 ? v.slice(0, 57) + '...' : v) : String(v);
        return `${k}=${s}`;
      })
      .join(' ');
    process.stderr.write(`[compositor] t=${t} ${stage}${kv ? ' ' + kv : ''}\n`);
  }

  constructor(opts: TerminalCompositorOptions) {
    this.stdout = opts.stdout;
    this.stdin = opts.stdin;
    this.onCancel = opts.onCancel;
    this.onSoftStop = opts.onSoftStop;
    this.onBackground = opts.onBackground;
    this.onShiftTab = opts.onShiftTab;
    // Normalize promptText to a function: string → constant closure;
    // function → use as-is; falsy → dim-chevron fallback.
    const promptOpt = opts.promptText;
    if (typeof promptOpt === 'function') {
      this.promptTextFn = promptOpt;
    } else if (typeof promptOpt === 'string') {
      this.promptTextFn = () => promptOpt;
    } else {
      const fallback = '  ' + palette.dim('⎯') + ' ';
      this.promptTextFn = () => fallback;
    }
    this.history = opts.history;
    this.autocompleteState = opts.autocompleteState;
    this.formatInputBuffer = opts.formatInputBuffer;
    this.scrollRegion = opts.scrollRegion;
    this.spinnerController = new SpinnerController({
      captureMode: opts.captureMode ?? false,
      onTick: () => this.repaint(),
    });
    this.onSubmit = opts.onSubmit;
    this.anchorRow = opts.anchorRow;
    this.declaredAnchorRow = opts.anchorRow;
    this.ghostEngine = opts.suggest?.engine;
    this.ghostGetContext = opts.suggest?.getContext;
  }

  isArmed(): boolean {
    return this.armed;
  }

  /**
  /**
   * Update the anchor row at runtime — see
   * {@link TerminalCompositorOptions.anchorRow}. Callers (typically the
   * surface that wraps this compositor) use this to install or replace
   * the safe ceiling after construction.
   *
   * Updates BOTH the working {@link anchorRow} (effective immediately)
   * AND {@link declaredAnchorRow} (the snapshot restored on rearm) so
   * the caller's most-recent explicit intent survives disarm/rearm
   * cycles on the same instance. This is distinct from the eviction
   * shift in {@link repaint}, which mutates only the working anchor —
   * a post-eviction value is per-cycle state, not declared intent.
   *
   * Passing `undefined` disables protection (legacy behavior — frame
   * grows to row 1 without evicting).
   */
  setAnchorRow(row: number | undefined): void {
    this.anchorRow = row;
    this.declaredAnchorRow = row;
  }

  /**
   * Temporarily yield stdin raw-mode and the keypress listener so an
   * external readline interface (e.g. `rl.question()` used by the
   * elicitation handler) can receive keystrokes cleanly.
   *
   * The compositor remains "armed" (armed=true) throughout — `resumeInput()`
   * restores the listener and raw mode without going through the full
   * arm/disarm cycle. Idempotent: calling when already suspended is a
   * no-op. Must be paired with a matching `resumeInput()`.
   */
  suspendInput(): void {
    if (!this.armed || this.suspended) return;
    // Clear the live overlay so the compositor frame doesn't visually
    // compete with the readline prompt that is about to appear below it.
    if (this.logUpdate) {
      try { this.logUpdate.clear(this.scrollRegion?.getExtraRows() ?? 0); this.logUpdate.done(); } catch { /* noop */ }
    }
    if (this.handleKeypress) {
      this.stdin.removeListener('keypress', this.handleKeypress);
    }
    try { this.stdin.setRawMode(false); } catch { /* noop */ }
    this.suspended = true;
  }

  /**
   * Restore the keypress listener and raw mode after a `suspendInput()`
   * call. Idempotent: calling when not suspended is a no-op.
   */
  resumeInput(): void {
    if (!this.armed || !this.suspended) return;
    try { this.stdin.setRawMode(true); } catch { /* noop */ }
    if (this.handleKeypress) {
      this.stdin.on('keypress', this.handleKeypress);
    }
    this.suspended = false;
    this.repaint();
  }

  /**
   * Install or clear the submission handler. The InputSurface uses
   * this to wire `surface.readLine()` to the compositor's Enter
   * pipeline without reconstructing the compositor.
   *
   * Passing `null` clears the handler — Enter then falls back to
   * the today-behavior (queue in streaming mode; no-op in idle mode
   * since there is no handler to resolve).
   */
  setOnSubmit(handler: ((payload: SubmissionPayload) => void) | null): void {
    this.onSubmit = handler ?? undefined;
  }

  /**
   * Install or clear the cancel handler — see
   * {@link TerminalCompositorOptions.onCancel}. The persistent
   * InputSurface uses this to swap between `handleSigint` (idle) and
   * `() => session.interrupt()` (mid-stream) at turn boundaries.
   */
  setOnCancel(handler: (() => void) | null): void {
    this.onCancel = handler ?? undefined;
  }

  /**
   * Read the currently-installed cancel handler. Used by borrow-style
   * consumers (e.g. {@link StreamRenderer}) to capture the owner's
   * onCancel before swapping in a per-skill closure, then restore the
   * captured handler at dispose time. Without this, a borrow that calls
   * `setOnCancel(null)` on dispose would clear the owner's handler too
   * (the owner installed it via the constructor, not via setOnCancel,
   * so there is no other path to recover it) — leaving the compositor
   * with `onCancel === undefined`, which silently no-ops Ctrl+C in idle
   * mode (terminal-compositor.ts:1106-1108).
   */
  getOnCancel(): (() => void) | undefined {
    return this.onCancel;
  }

  /**
   * Install or clear the soft-stop handler — see
   * {@link TerminalCompositorOptions.onSoftStop}. Wired once at REPL
   * startup via InputSurface.armCompositor; no per-turn swap needed
   * because the once-only `softStopped` guard handles idempotency.
   */
  setOnSoftStop(handler: (() => void) | null): void {
    this.onSoftStop = handler ?? undefined;
  }

  /**
   * Install or clear the background handler — see
   * {@link TerminalCompositorOptions.onBackground}. Typically cleared
   * in idle mode (Ctrl+B has no meaningful between-turn semantics).
   */
  setOnBackground(handler: (() => void) | null): void {
    this.onBackground = handler ?? undefined;
  }

  /**
   * Install or clear the Shift+Tab handler — see
   * {@link TerminalCompositorOptions.onShiftTab}. The persistent
   * InputSurface typically installs this once at REPL start (the
   * plan-mode toggle is REPL-global, not per-turn).
   */
  setOnShiftTab(handler: (() => void) | null): void {
    this.onShiftTab = handler ?? undefined;
  }

  /**
   * Rent the input region to a picker overlay — see
   * {@link PickerController}. While active, the compositor's input
   * buffer + dropdown + hint rows are hidden, and all keystrokes
   * route to `controller.onKey`. The picker is responsible for its
   * own cancel/confirm semantics; the compositor offers no Enter/Esc
   * defaults in picker mode.
   *
   * Invariant: the autocomplete dropdown must NOT bleed into the
   * picker frame, so this method calls `autocompleteState?.reset()`.
   * The previous `inputMode` is saved and restored by
   * {@link exitPickerMode}.
   *
   * @throws if a picker is already active (callers must `exitPickerMode`
   * before installing a new controller).
   */
  enterPickerMode(controller: PickerController): void {
    if (this.pickerController) {
      throw new Error('enterPickerMode: a picker is already active; call exitPickerMode first');
    }
    this.pickerSavedMode = this.inputMode;
    this.pickerController = controller;
    this.inputMode = 'picker';
    // Clear the autocomplete dropdown so its rows don't render on top
    // of the picker frame (see compositor risk #2 in the integration
    // brief — repaint composes dropdown rows from autocompleteState
    // and ignores inputMode otherwise).
    this.autocompleteState?.reset();
    this.repaint();
  }

  /**
   * Exit picker mode and restore the previous input mode. The picker
   * controller is cleared and the compositor resumes rendering its
   * own input buffer + dropdown rows.
   *
   * No-op when no picker is active (idempotent — safe to call from
   * cleanup paths that don't know whether `enterPickerMode` was reached).
   */
  exitPickerMode(): void {
    if (!this.pickerController) return;
    this.pickerController = null;
    this.inputMode = this.pickerSavedMode;
    this.repaint();
  }

  /**
   * Force a repaint while the picker is active. The picker calls
   * this after mutating its internal selection state so the next
   * `renderRows()` invocation reflects the new state.
   *
   * No-op when no picker is active (defence-in-depth — a late repaint
   * from a cancelled picker won't double-render the input row).
   */
  repaintPicker(): void {
    if (!this.pickerController) return;
    this.repaint();
  }

  /**
   * Invariant: in the `→ 'idle'` flush path with `queued && onSubmit`, fire
   * `onSubmit(buffer)` BEFORE clearing `queued` and the buffer (teardown-
   * before-setup; otherwise a reentrant onSubmit observes stale state).
   *
   * Transition input mode. Default is `'streaming'`; the persistent
   * InputSurface flips to `'idle'` between turns and back to
   * `'streaming'` at turn start.
   *
   * ## Ordered operation
   *
   * External constraint: `→ 'idle'` with `queued && onSubmit` MUST
   * fire `onSubmit(buffer)` BEFORE clearing `queued` and the buffer.
   * Otherwise a reentrant `onSubmit` handler (e.g. one that
   * synchronously calls `setInputMode('streaming')` again) would
   * observe stale state. Mirror of the teardown-before-setup
   * invariant on TUI lifecycle ops.
   *
   * ## Flush semantics (mode → idle)
   *
   * Fires on ANY transition to idle while queued + handler are both
   * set, not just `streaming → idle`. The `idle → idle` case covers
   * a race where the user types-and-Enters in the brief window
   * between a previous `readLine` resolving and the next one
   * installing a handler: the Enter falls through to the streaming-
   * queue branch (sets `queued=true`), and the next `readLine`'s
   * `setInputMode('idle')` is what fires the synthesized submission.
   * Without this widening, the queued buffer would be stranded until
   * the user pressed Enter a second time.
   */
  setInputMode(mode: CompositorInputMode): void {
    const prev = this.inputMode;
    this.inputMode = mode;
    // idle → streaming: clear the once-only canceled/backgrounded/softStopped
    // guards so the new turn can be interrupted (ESC/Ctrl+C) and/or
    // backgrounded (Ctrl+B). Without this reset, a Ctrl+C or ESC between two
    // turns would arm the once-only flag in the second turn, breaking
    // ESC/Ctrl+C mid-stream forever after.
    if (prev === 'idle' && mode === 'streaming') {
      this.canceled = false;
      this.backgrounded = false;
      this.softStopped = false;
      // Reset autocomplete at the idle→streaming transition so any
      // open dropdown rows are not rendered into the first streaming
      // frame. Mirrors the reset in the idle Enter handler above.
      // Both sites are needed: the Enter handler fires when onSubmit is
      // installed (persistent InputSurface path); this branch fires when
      // the caller drives mode directly (e.g. slash-command dispatcher
      // calling setInputMode('streaming') from outside readLine).
      this.autocompleteState?.reset();
      this.repaint();
      return;
    }
    // Invariant: a buffer queued during or after an ESC soft-stop MUST NOT
    // auto-flush as a phantom next turn, AND `softStopped` MUST be cleared at
    // this first →idle transition (NOT left to persist until the next arm).
    // `softStopped` is set only by ESC, and its ONLY function is the once-only
    // ESC guard during streaming (handleEscape ~line 1937); in idle, ESC
    // returns early (line ~1920) before that guard, so a lingering value has
    // no legitimate effect. We clear the queued FLAG here (buffer text +
    // attachments preserved) so the post-ESC draft stays visible + editable in
    // the idle input row and waits for an explicit Enter instead of
    // auto-submitting — a stream interruption should preserve in-progress
    // input, not fling it as a turn the user never confirmed. This fires at
    // the dispose→idle transition (streaming→idle).
    //
    // Why clear softStopped HERE (the fix): if it persists into the idle
    // period, it poisons the user's NEXT message. After an EMPTY-buffer ESC
    // (the common "just stop the agent" case) `queued` stays false, so the old
    // `&& this.queued` guard never fired and softStopped survived the dispose.
    // The user then types a new message in the brief inter-readLine window
    // (onSubmit not yet installed → Enter queues it); the following
    // readLine→idle would re-enter this guard (softStopped && queued both
    // true) and SILENTLY DE-QUEUE the message — it "looks like it sends" but
    // no turn starts, and the user must send again (a per-stop off-by-one that
    // reads as session-wide lag). Dropping the `&& this.queued` condition and
    // resetting softStopped here bounds its lifetime to the stopped turn, so
    // idle-window submissions flush normally via the branch below.
    //
    // Without this guard at all: session.interrupt() is deferred to the next
    // stream event (turn-handler.ts:236 / run-skill-dispatch-turn.ts:143), so
    // the compositor stays in streaming mode for a network-latency window. An
    // Enter pressed in that window queues the buffer; the widened any→idle
    // flush below then auto-fires it as an unconfirmed turn, and every message
    // the user types during THAT turn queues in turn — a perpetual
    // input-lag-of-one (each message submits one turn late) for the rest of
    // the session. See terminal-compositor.test.ts soft-stop drain tests.
    //
    // ESC-only: Ctrl+C intentionally uses the legacy path — handleInterrupt
    // (~line 1937) queues the buffer and fires onCancel; the widened any→idle
    // flush below auto-submits it as the next turn. ESC preserves the draft
    // for explicit (manual) submission; Ctrl+C auto-submits it. (see handleInterrupt ~line 1937-1957)
    if (mode === 'idle' && this.softStopped) {
      this.queued = false;
      this.softStopped = false;
      // Always repaint: the `[queued]` glyph must clear even on an
      // idle→idle transition (the flush branch below repaints
      // unconditionally for the same reason).
      this.repaint();
      return;
    }
    // → idle with queued buffer + handler: flush. Widened from
    // streaming→idle to any→idle to cover the inter-readLine race
    // (see jsdoc above). Buffer-empty + attachment-empty queues are
    // ignored — Enter on a fully-empty input is suppressed at the
    // keypress level (compositor.ts:1148) so this branch only fires
    // when there's something meaningful to submit.
    if (mode === 'idle' && this.queued && this.onSubmit) {
      // displayText keeps the placeholder representation (for the
      // scrollback echo); text is the expanded form (for the model).
      // When no truncation happened the two are byte-equal and
      // displayText is omitted from the payload to keep existing
      // call-sites that deep-match on { text, attachments } happy.
      const displayText = this.input.buffer;
      const expandedText = Paste.expandPastePlaceholders(this, displayText);
      const attachments = [...this.attachments];
      const handler = this.onSubmit;
      // Clear local state BEFORE invoking the handler so a reentrant
      // call back into this compositor (e.g. handler triggers another
      // setInputMode) does not double-fire on the same buffer.
      this.queued = false;
      this.input = InputCore.seed('');
      this.attachments = [];
      this.pasteRegistry.clear();
      this.repaint();
      handler(
        expandedText === displayText
          ? { text: expandedText, attachments }
          : { text: expandedText, displayText, attachments },
      );
      return;
    }
    // Other transitions (idle→idle without queue, streaming→streaming,
    // → idle without handler) just record the new mode. A → idle with
    // queued but no handler is a no-op — the buffer stays queued
    // (matches the legacy contract where the parent reads via
    // getBuffer()).
    if (prev !== mode) this.repaint();
  }

  /**
   * Current input mode. Surfaced for tests + the InputSurface idle
   * check; not consumed by any production code path inside the
   * compositor outside of {@link setInputMode}.
   */
  getInputMode(): CompositorInputMode {
    return this.inputMode;
  }

  async arm(): Promise<void> {
    if (this.armed) throw new Error('TerminalCompositor: arm() called while already armed');

    if (!this.stdout.isTTY || !this.stdin.isTTY) {
      // Non-TTY: compositor stays inert. Callers should skip creation in
      // this case; we degrade gracefully anyway.
      return;
    }

    // Restore the working anchor from the caller-declared snapshot. On
    // a fresh construction these match; on a rearm after eviction, the
    // working anchor has shifted (e.g. 15 → 11) and resetState() cleared
    // it, so we re-seed from the declared intent. The caller is the only
    // party that knows the actual viewport state — if it differs from the
    // declared value, they must call setAnchorRow() before/after the
    // rearm. See declaredAnchorRow field comment.
    this.anchorRow = this.declaredAnchorRow;

    if (!this.logUpdate) {
      this.logUpdate = new CupFrameRenderer(this.stdout) as unknown as LogUpdateFn;
    }

    this.wasRaw = this.stdin.isRaw ?? false;
    try {
      this.stdin.setRawMode(true);
    } catch {
      this.logUpdate = null;
      this.wasRaw = false;
      return;
    }
    // Enable bracketed-paste mode so the terminal wraps clipboard content
    // in `\x1b[200~ ... \x1b[201~`. Without this, multi-line pastes arrive
    // as a stream of raw keypresses including `\r`, and the Enter handler
    // cannot distinguish pasted line breaks from user-submission Enter —
    // the first `\r` prematurely submits in idle mode (the regression this
    // restores). The dispatchKey() Enter branch checks `this.pasting` to
    // detect "inside a paste window" and insert a literal `\n` instead.
    // Disabled in disarm() so a non-bracketed-paste-aware caller picking
    // up the TTY after us doesn't see literal `~`-bracketed sequences.
    try {
      this.stdout.write('\x1b[?2004h');
    } catch {
      /* best-effort — terminals that don't support DEC private modes
         silently drop unknown set/reset sequences, so a thrown write
         likely means stdout was closed mid-arm. */
    }
    this.stdin.resume();
    // Lone ESC must register on the first press — it is the soft-stop
    // affordance. emitKeypressEventsImmediateEscape sets a small sub-perception
    // escapeCodeTimeout (Node's default 500ms keyseq-timeout is the "ESC needs
    // two presses" bug; see emit-keypress.ts for why nonzero). The decoder is
    // idempotent per stream, so the first surface to attach it (this,
    // reader.ts, elicitation-repl.ts) locks the timeout in; all of them call
    // the helper with the same value, so it wins regardless of order.
    emitKeypressEventsImmediateEscape(this.stdin);

    // Acquire the process-wide stdin claim immediately before attaching the
    // keypress listener so the invariant is upheld: only one stdin consumer
    // may be live at a time. Released in disarm().
    this.stdinClaim = acquireStdinClaim('TerminalCompositor.arm');

    this.handleKeypress = (char, key) => this.dispatchKey(char, key);
    this.stdin.on('keypress', this.handleKeypress);

    // Invariant (arm ordering): set `armed = true` BEFORE registering the
    // ResizeBus subscribers below. The immediate channel fires synchronously
    // inside stdout's 'resize' event — if a SIGWINCH arrives between
    // `subscribeImmediate()` and `armed = true`, the handler's armed guard
    // would silently skip `resetGeometry()` and re-introduce the ghost-rows
    // bug this path exists to prevent (the debounced handler would still
    // call repaint() 150ms later, but against stale geometry). At this point
    // logUpdate, raw mode, bracketed-paste, and the keypress listener are
    // all wired — armed=true is consistent.
    this.armed = true;
    this.canceled = false;

    // External constraint (terminal resize semantics): SIGWINCH changes
    // `stdout.rows`, which changes the `targetBottomRow` passed to
    // CupFrameRenderer.render(). On the next repaint() the renderer reads the
    // current `stdout.rows` and positions the frame correctly — no separate
    // anchor step is needed (unlike log-update, which required an explicit
    // CUP before its first frame). The ResizeBus subscriber only needs to
    // trigger a repaint so the renderer recomputes the new bottom row.
    this.resizeUnsub = ResizeBus.subscribe(() => {
      // Defense-in-depth: skip if disarmed between SIGWINCH and the
      // 150ms-later debounced fire. `armed = true` is set above before
      // subscribe, so the arm-window race is closed; this guard only
      // protects the disarm-window race.
      if (!this.armed) return;
      this.repaint();
    });
    // Invariant (SIGWINCH ordering): the debounced subscriber above fires
    // 150ms after the resize. During that window, spinner ticks (80ms) and
    // streaming events (50–80Hz) can call repaint() — which reads the NEW
    // stdout.rows for targetBottomRow but the CupFrameRenderer still holds
    // OLD previousTopRow/previousLineCount, producing the ghost-rows /
    // blank-stripe artifact (see CupFrameRenderer.resetGeometry docs).
    // The immediate channel fires synchronously inside the 'resize' event
    // BEFORE any such mid-window repaint can execute, so the next render()
    // skips its stale-erase pass and paints fresh at the new geometry.
    this.resizeImmediateUnsub = ResizeBus.subscribeImmediate(() => {
      if (!this.armed) return;
      // Invariant (SIGWINCH ghost-erase, expand-only): on EXPAND the terminal
      // keeps existing content anchored at the top and opens blank rows at the
      // new bottom, so the old live-frame AND committed-band rows freeze at
      // their pre-resize absolute positions while the next render paints a fresh
      // frame at the new (lower) bottom — orphaning the old rows as on-screen
      // ghosts (resetGeometry() below makes the render's erase pass a no-op, and
      // the band is no longer cleared here). Snapshot that footprint so the next
      // repaint() can physically erase it. This is side-effect-only (no I/O),
      // honoring the subscribeImmediate "no I/O, no rendering" contract
      // (terminal-size.ts) — the actual erase happens in repaint().
      //
      // On SHRINK the terminal scrolls content up, so those absolute rows now
      // hold reflowed content and must NOT be erased; skip the snapshot and let
      // the fresh repaint + band re-pin settle the new geometry. A SHRINK must
      // also DROP any snapshot armed by an earlier EXPAND in the same
      // pre-repaint window (a drag that overshoots larger then settles smaller
      // than it started): lastKnownRows only advances on repaint(), so a stale
      // snapshot would otherwise survive and flushResizeGhostErase would clamp
      // its old `bottom` into the new viewport and wipe live rows — including
      // the reserved status-line region — that the next frame repaint never
      // restores. See terminal-compositor.resize-ghost.test.ts ("EXPAND then
      // SHRINK before a repaint").
      const newRows = this.stdout.rows ?? 24;
      if (this.lastKnownRows > 0 && newRows > this.lastKnownRows) {
        const extraRows = this.scrollRegion?.getExtraRows() ?? 0;
        const frameTop = this.logUpdate?.topRow ?? 0;
        const bandTop = this.committedBand.length > 0 ? this.committedBandTopRow : 0;
        const tops = [frameTop, bandTop].filter((r) => r > 0);
        const top = tops.length > 0 ? Math.min(...tops) : 0;
        // The frame is always bottom-anchored at the OLD targetBottomRow.
        const bottom = Math.max(1, this.lastKnownRows - 1 - extraRows);
        if (top > 0 && top <= bottom) {
          this.pendingResizeErase = { top, bottom };
        }
      } else {
        // Net SHRINK or net-zero resize: any snapshot armed by a prior EXPAND
        // in this same pre-repaint window is now stale (see above) — drop it so
        // the clamped flush cannot wipe post-shrink reflowed/status rows.
        this.pendingResizeErase = null;
      }
      this.logUpdate?.resetGeometry?.();
      // NOTE: the committed band is intentionally NOT cleared here. Preserving
      // its content lets repositionCommittedBand() re-pin it directly above the
      // frame at the NEW geometry on the next repaint (it recomputes the band's
      // rows from the new frame top; the stale committedBandTopRow is only read
      // for a redundant vacated-gap erase, never a stale paint). The old
      // on-screen band copy is cleared via pendingResizeErase above on EXPAND,
      // or scrolled by the terminal on SHRINK.
    });

    // Intentionally NOT calling `updateAutocomplete()` here. The compositor's
    // own `this.input` is always `InputCore.seed('')` at arm time (constructor
    // init + `resetState()` on disarm both reset it), so there is nothing to
    // rehydrate from. Calling `updateAutocomplete()` would clobber any
    // caller-supplied `autocompleteState` that legitimately carries an open
    // dropdown across an arm/disarm cycle — which is the contract tested in
    // `src/cli/input/autocomplete-state.test.ts` ("↑/↓ navigates dropdown,
    // not history"). The first real keystroke during the agent turn will
    // refresh the state via `applyEdit()` → `updateAutocomplete()`.

    this.repaint();
  }

  disarm(): void {
    this.spinnerController.dispose();

    if (!this.armed) {
      // Still safe to clear state — no-op for listener/raw-mode.
      this.resetState();
      return;
    }

    if (this.handleKeypress) {
      this.stdin.removeListener('keypress', this.handleKeypress);
      this.handleKeypress = null;
    }
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    if (this.resizeImmediateUnsub) {
      this.resizeImmediateUnsub();
      this.resizeImmediateUnsub = null;
    }

    if (this.logUpdate) {
      try {
        this.logUpdate.clear(this.scrollRegion?.getExtraRows() ?? 0);
        // log-update hides the cursor on every render() when showCursor is
        // false (the default). Only done() calls cliCursor.show(); clear()
        // alone leaves the cursor hidden, leaking that state for the rest
        // of the session. Call done() after clear() to restore the cursor
        // before relinquishing control back to readline.
        this.logUpdate.done();
      } catch {
        /* noop */
      }
    }

    if (this.stdout.isTTY && this.stdin.isTTY) {
      // External constraint (drain ordering): disable bracketed-paste BEFORE
      // restoring raw mode. On rapid disarm/process-exit, the two writes
      // can race against the kernel TTY flush — restoring raw mode first
      // can cause the disable sequence to be dropped, leaving the terminal
      // in bracketed-paste mode after the process exits (subsequent shell
      // commands see literal `\x1b[200~`/`\x1b[201~` around clipboard
      // pastes). Mirrors the single-drain ordering in raw-mode.ts.
      try {
        this.stdout.write('\x1b[?2004l');
      } catch {
        /* stdout may have been closed */
      }
      try {
        this.stdin.setRawMode(this.wasRaw);
      } catch {
        /* noop */
      }
    }

    // Release the stdin claim before marking as unarmed so a subscriber
    // that checks isArmed() inside an acquire call sees the correct state.
    if (this.stdinClaim) {
      this.stdinClaim.release();
      this.stdinClaim = null;
    }

    this.armed = false;
    this.resetState();
    // Dispose the suggest engine AFTER resetState so no pending promise
    // resolves try to call repaint() on a disarmed compositor. The engine's
    // dispose() signals all in-flight promises to resolve null — the
    // buffer-identity guard in updateGhost's resolve handler will then
    // silently drop any result that arrives after this point.
    this.ghostEngine?.dispose();
  }

  setOverlay(text: string): void {
    // Skip the repaint when the overlay text is identical — at sustained
    // streaming rates (live-thinking chunks land ~50 Hz) the same text often
    // arrives back-to-back from upstream coalescing, and the spinner row,
    // input line, and dropdown each drive their own repaint paths when their
    // own state changes, so a no-op overlay write produces no visible delta.
    if (text === this.overlay) return;
    this.debugLog('setOverlay', { framesLen: text.length, anchorRow: this.anchorRow ?? null });
    this.overlay = text;
    this.repaint();
  }

  // ora's imperative cursor + linesToClear tracking collides with log-update's
  // region tracking when both run concurrently. The SpinnerController owns the
  // spinner state + 80ms ticker; the compositor owns the frame and pulls the
  // spinner/tip rows from it at repaint time, so the spinner row lives inside
  // the same render frame and the race is eliminated. The TTY guard stays here
  // — the controller is terminal-agnostic and assumes an interactive surface.
  setSpinner(config: { enabled: boolean; rotateVerbEveryMs?: number }): void {
    if (!this.stdout.isTTY) return;
    this.spinnerController.set(config);
  }

  // Committed-band lifecycle extracted to terminal-compositor.committed-band.ts
  // (free-functions-on-host). The band state (committedBand, *Row, commit-state
  // flags, pendingResizeErase) stays on this class because the resize/scrollback
  // test suite reaches into it; these delegators forward to the module.

  commitAbove(text: string): void {
    CommittedBand.commitAbove(this, text);
  }

  private clearCommittedBand(): void {
    CommittedBand.clearCommittedBand(this);
  }

  /**
   * Physically erase the pre-resize on-screen footprint snapshotted by the
   * SIGWINCH immediate handler. Body extracted to
   * terminal-compositor.committed-band.ts — see {@link CommittedBand.flushResizeGhostErase}.
   */
  private flushResizeGhostErase(): void {
    CommittedBand.flushResizeGhostErase(this);
  }

  /**
   * Drop the retained above-frame committed band + commit-presence flags
   * without tearing down the arm cycle (REPL `/clear` path). Body extracted to
   * terminal-compositor.committed-band.ts — see {@link CommittedBand.resetCommittedBand}.
   */
  resetCommittedBand(): void {
    CommittedBand.resetCommittedBand(this);
  }

  /**
   * Re-pin the most-recent above-frame committed block so its bottom line stays
   * immediately above the live frame top after a repaint. Body extracted to
   * terminal-compositor.committed-band.ts — see {@link CommittedBand.repositionCommittedBand}.
   */
  private repositionCommittedBand(
    desiredTopRow: number,
    preRenderFrameTop: number,
    targetBottomRow: number,
  ): void {
    CommittedBand.repositionCommittedBand(this, desiredTopRow, preRenderFrameTop, targetBottomRow);
  }

  getBuffer(): { text: string; queued: boolean } {
    // Expand any `[Pasted text #N +M lines]` placeholders back to
    // their original content so callers reading this snapshot see
    // submission-shaped text (what the model will receive), not
    // placeholder tokens. Primarily used by tests; production submit
    // paths read this.input.buffer directly so expansion and registry
    // clear happen in the same atomic operation.
    //
    // CAUTION: do not call getBuffer() after submit fires — pasteRegistry
    // is cleared before the handler so placeholders would pass through
    // unexpanded. For the raw buffer with placeholders intact, read
    // this.input.buffer directly.
    //
    // No-op fast path when no truncation happened in this compose window.
    return { text: Paste.expandPastePlaceholders(this, this.input.buffer), queued: this.queued };
  }

  /**
   * Snapshot the current attachment list. Returned array is a shallow
   * copy — callers can persist or mutate without affecting the
   * compositor's internal state. Empty when no bracketed-paste /
   * Ctrl+V probe has fired since the last submission.
   */
  getAttachments(): ImageAttachment[] {
    return [...this.attachments];
  }

  // Body extracted to terminal-compositor.render.ts (free-functions-on-host).
  private renderInputLine(): string {
    return Render.renderInputLine(this);
  }

  /**
   * Recompute autocomplete candidates from the current buffer/cursor and
   * store results back into the shared AutocompleteState. Called on every
   * printable keypress, backspace, and left/right so the dropdown stays
   * consistent with the buffer content during the agent turn.
   */
  // Body extracted to terminal-compositor.autocomplete.ts (free-functions-on-host).
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  updateAutocomplete(): void {
    Autocomplete.updateAutocomplete(this);
  }

  /**
   * Update the active ghost text for the current buffer state. Body extracted
   * to terminal-compositor.autocomplete.ts — see {@link Autocomplete.updateGhost}
   * for the keystroke-path and stale-async-guard invariants.
   */
  private updateGhost(): void {
    Autocomplete.updateGhost(this);
  }

  /**
   * Render autocomplete dropdown rows for the compositor frame. Body extracted
   * to terminal-compositor.render.ts — see {@link Render.renderDropdownRows}
   * for the bottom-pinned row-ordering invariant.
   */
  private renderDropdownRows(): string[] {
    return Render.renderDropdownRows(this);
  }

  /**
   * Render the selected-candidate `↳ <when-to-use>` hint row. Body extracted
   * to terminal-compositor.render.ts — see {@link Render.renderHintRow} for
   * the frame-height-stability invariant (always non-null while the dropdown
   * is open, so the row count stays constant across ↑/↓ navigation).
   */
  private renderHintRow(): string | null {
    return Render.renderHintRow(this);
  }

  /** @internal Public for sibling free-function modules (via Host interfaces) and test casts. */
  repaint(): void {
    // Invariant: when suspended for an external readline (elicitation
    // `rl.question`, arrow-key selector), the compositor MUST NOT repaint —
    // the spinner ticker (80ms `setInterval`) and any out-of-band setOverlay
    // callers will otherwise clobber the user's prompt and typed characters.
    // Restored by `resumeInput()` which itself calls `repaint()` once.
    if (!this.armed || !this.logUpdate || this.committing || this.suspended) return;
    // Resize ghost-erase: physically clear the pre-resize on-screen footprint
    // captured by the SIGWINCH immediate handler BEFORE painting the new
    // geometry, so an expand does not leave the old frame/band frozen as
    // ghosts. Placed above the picker short-circuit so both normal and picker
    // repaints flush it. Recording lastKnownRows here (every repaint, both
    // paths) gives the resize handler the pre-resize row count to detect
    // expand vs shrink.
    this.flushResizeGhostErase();
    this.lastKnownRows = this.stdout.rows ?? 24;
    // Picker-mode short-circuit. The picker rents the input region
    // (dropdown + hint + input line all suppressed) and supplies its
    // own rows via `renderRows()`. Overlay/spinner/tip/attachment
    // rows still stack above — picker mode only displaces the
    // bottom cluster the picker visually replaces.
    //
    // Invariant: the LAST entry of `frameLines` must occupy the
    // bottom row (the DECSTBM scroll-region anchor). The picker's
    // last `renderRows()` entry is treated as the bottom-pinned row
    // — typically the help line ("↑/↓ navigate · enter select").
    if (this.inputMode === 'picker' && this.pickerController) {
      this.repaintPickerFrame();
      return;
    }
    const inputLine = this.renderInputLine();
    const overlayLines = this.overlay ? this.overlay.split('\n') : [];
    const spinnerRow = this.spinnerController.renderSpinnerRow();
    // Tip row sits BELOW the spinner row, ABOVE the input line. Renders only
    // when the spinner has a tip — `selectTip` enforces the warmup grace, so
    // sub-second turns never paint a tip and then tear it down.
    const tipRow = this.spinnerController.renderTipRow(this.stdout.columns ?? 80);
    // Attachment status row — listed pasted/clipboard images so the user
    // can see what's about to ride along on the next submission. Mutually
    // exclusive with the clipboard-failure row (an ephemeral notice that
    // last clipboard probe found no image — paint-clear: consumed on
    // this repaint so the message disappears as soon as the user acts).
    let attachmentRow: string | null = null;
    if (this.attachments.length > 0) {
      attachmentRow = renderStatusLine(this.attachments);
    } else if (this.clipboardFailureMsg !== null) {
      attachmentRow = palette.dim(this.clipboardFailureMsg);
      this.clipboardFailureMsg = null;
    }
    const dropdownRows = this.renderDropdownRows();
    const hintRow = this.renderHintRow();
    // Visual breathing room: when ANY chrome sits above the input cluster
    // (overlay, spinner, tip, or attachment row), insert a blank line so
    // the input has its own visual region instead of getting glued to the
    // last status row. The dropdown+hint sit adjacent to the input by
    // design (fish/atuin "input pinned, content rises" geometry — see the
    // frame composition comment below), so the gap separates chrome from
    // the entire (dropdown→hint→input) bottom cluster, not from the input
    // alone. Idle state — empty overlay AND no spinner/tip/attachment —
    // keeps the prompt flush so we don't waste a viewport row on a
    // permanent leading blank. The decision must be made BEFORE we
    // compute fixedRows so the overlay budget reserves space for the gap.
    const hasFixedChrome = !!spinnerRow || !!tipRow || !!attachmentRow;
    const hasContentAboveInput = hasFixedChrome || overlayLines.length > 0;
    // Cap the frame at viewport height. log-update tracks the previous
    // frame's line count and clears that many lines on the next paint;
    // when the prior frame exceeded the viewport, lines that scrolled
    // off the top can no longer be reached by its cursor-up codes and
    // get stranded in scrollback. Keeping the most recent overlay lines
    // (and always the spinner+tip+attachment+gap+dropdown+hint+input rows)
    // keeps the frame log-update can fully clear.
    //
    // Invariant: the bg status bar (when active) owns rows (rows-extraRows)..(rows-1).
    // Compositor frame must stay above that region or the two writers race the same physical row
    // every spinner tick, producing flicker. Mirrors DECSTBM math in status-line.ts:287.
    const extraRows = this.scrollRegion?.getExtraRows() ?? 0;
    const maxLines = Math.max(1, (this.stdout.rows ?? 24) - 1 - extraRows);
    // hintRow is '' (a reserved blank slot) for un-hinted candidates and
    // a non-empty `↳ …` string for hinted ones — both occupy one row.
    // Test against `!== null` so the empty-string slot still counts.
    const gapRows = hasContentAboveInput ? 1 : 0;
    const fixedRows = (spinnerRow ? 1 : 0) + (tipRow ? 1 : 0)
      + (attachmentRow ? 1 : 0) + gapRows + dropdownRows.length
      + (hintRow !== null ? 1 : 0) + 1;
    const overlayBudget = Math.max(0, maxLines - fixedRows);
    const trimmedOverlay = overlayLines.length > overlayBudget
      ? overlayLines.slice(-overlayBudget)
      : overlayLines;
    // Re-derive after trimming: if the overlay was the only thing above
    // input and got entirely trimmed away by the viewport budget, suppress
    // the gap. (fixedRows over-reserved by 1 in that edge case, harmless.)
    const renderGap = hasFixedChrome || trimmedOverlay.length > 0;
    // Note: we deliberately do NOT pre-pad overlay/spinner/tip/input lines
    // for soft-wraps. log-update v8 wraps internally via wrap-ansi(hard:true)
    // before computing its tracked line count and detects width changes to
    // do a full erase+redraw (`previousWidth !== width` branch in
    // node_modules/log-update/index.js). Pre-padding here would inflate the
    // row count log-update sees, causing it to over-erase on the next paint.
    //
    // Invariant: the input line MUST be the last entry of `frameLines` so
    // it consistently lands at the bottom of the log-update region — which
    // the DECSTBM scroll region pins one row above the status line. The
    // dropdown (when open) sits directly above the input and grows upward
    // as more candidates are visible; the `↳ <when-to-use>` hint sits in
    // between (closest to the input). Streaming overlay / spinner / tip /
    // attachment rows stack above the dropdown, pushing UPWARD into the
    // streaming region as they grow rather than shoving the input row off
    // its anchor. This is the "input pinned, content rises" geometry —
    // dropdown opening, attachment ack, and spinner activation never shift
    // the cursor row the user is typing on.
    const frameLines: string[] = [];
    frameLines.push(...trimmedOverlay);
    if (spinnerRow) frameLines.push(spinnerRow);
    if (tipRow) frameLines.push(tipRow);
    if (attachmentRow) frameLines.push(attachmentRow);
    // Gap row sits between chrome and the (dropdown→hint→input) cluster
    // so the input + its completion popup stay visually adjacent (the
    // "input pinned, content rises" invariant above). With no chrome, no
    // gap — keeps the prompt flush against the top of an idle viewport.
    if (renderGap) frameLines.push('');
    frameLines.push(...dropdownRows);
    // `hintRow !== null` keeps the reserved blank-row slot for
    // un-hinted candidates so the dropdown above doesn't shift up by 1
    // row when the user navigates across a hinted ↔ un-hinted boundary.
    if (hintRow !== null) frameLines.push(hintRow);
    frameLines.push(inputLine);
    const targetBottomRow = Math.max(1, (this.stdout.rows ?? 24) - 1 - extraRows);
    // Anchor-row enforcement: when an upper-bound was supplied (typically by
    // the surface that knows how many rows the welcome banner / update-
    // notice consumed before arm), make sure the frame's top row does not
    // climb above it via CUP positioning. When it would, evict the deficit
    // into terminal scrollback FIRST (via DECSTBM-region `\n` writes that
    // scroll the current viewport up one row at a time) so the row at the
    // anchor that we are about to overwrite has already been preserved in
    // scrollback for the user to scroll back to. After eviction the anchor
    // shifts up by the same number of rows because the pre-arm content has
    // moved upward in the viewport — re-running this branch on the next
    // repaint with the same lineCount finds no deficit.
    const frame = frameLines.join('\n');
    // Wrap-aware top row: CupFrameRenderer hard-wraps at stdout.columns, so a
    // frame line wider than the terminal occupies >1 physical row. Sizing the
    // committed-band eviction/re-pin off the LOGICAL line count
    // (frameLines.length) under-counts in that case and re-pins the band INSIDE
    // the physical frame footprint, where the next render's erase pass clobbers
    // it (review #592). measure() returns the physical top render() will use; it
    // equals the logical count whenever nothing wraps. Stubs without measure()
    // fall back to the logical count.
    const desiredTopRow = this.logUpdate.measure
      ? this.logUpdate.measure(frame, targetBottomRow).topRow
      : Math.max(1, targetBottomRow - frameLines.length + 1);
    this.preserveRowsBeforeFrameRender(desiredTopRow);
    // Capture the renderer's current top BEFORE render(): it is the first row
    // its erase pass will clear, which repositionCommittedBand() uses to detect
    // whether the render wiped the band (the collapse render, whose stale-tall
    // top erases down through it).
    const preRenderFrameTop = this.logUpdate.topRow ?? 0;
    this.logUpdate.render(frame, targetBottomRow);
    this.repositionCommittedBand(desiredTopRow, preRenderFrameTop, targetBottomRow);
  }

  /**
   * Preserve rows that the next compositor frame is about to cover.
   *
   * Shared by normal input repaints and picker repaints: both ultimately use
   * the same log-update renderer, and both can grow upward into the single
   * above-frame copy written by `commitAbove()`. Keeping the eviction in one
   * pre-render path prevents picker mode from bypassing commit durability.
   */
  private preserveRowsBeforeFrameRender(desiredTopRow: number): void {
    // Evict-on-growth (durability for single-copy commits): when the frame
    // grows upward — its top climbs above the previously-rendered frame top —
    // the rows it is about to CUP-paint over hold committed transcript content
    // (commitAbove's above-frame band). Get that content into terminal
    // scrollback BEFORE the frame render overwrites it.
    const prevTopRow = this.logUpdate?.topRow ?? 0;
    const hasBanner = this.anchorRow !== undefined && this.anchorRow > 1;

    // History: the common case (no pre-arm banner, floor === 1). The old path
    // scrolled the FULL frame-growth deficit (prevTopRow - desiredTopRow) into
    // scrollback on every upward growth. When the band hugged the frame with
    // blank rows above it (a small band under a growing tall overlay — e.g. a
    // "thought for Xs" line committed while a tall thinking preview is up), it
    // was those BLANK rows that scrolled into scrollback — opening the "massive
    // gap" between committed clusters in scrollback. Worse: the band's content
    // was only ever a CUP re-paint, so the cap dropped lines believing they had
    // scrolled to scrollback when only blanks had — lost commits.
    //
    // Fix: on growth the band moves up into the blank space it already had above
    // it (no scrollback write at all when the whole band still fits). Only the
    // OLDEST lines that overflow the new above-frame room [1, desiredTopRow-1]
    // are scrolled into scrollback, carried as REAL content (the full band is
    // re-painted top-aligned first so the scroll evicts band rows, never
    // blanks). Because room === desiredTopRow - 1 here, the survivors land at
    // [1, desiredTopRow-1] — already hugging the new frame top AND contiguous
    // with scrollback, so no gap opens. Full design: docs/scrollback.md.
    if (!hasBanner) {
      const grew = this.hasCommitted && prevTopRow > 1 && desiredTopRow < prevTopRow;
      const bandLen = this.committedBand.length;
      if (!grew || bandLen === 0) return;
      const room = Math.max(0, desiredTopRow - 1);
      const overflow = bandLen - room;
      if (overflow <= 0) return; // whole band fits above the new frame — no scroll
      // Re-paint the full band top-aligned at [1, bandLen], erasing its old
      // floating position, so the scroll carries the oldest `overflow` lines —
      // real content, never blank rows — into scrollback. The frame render that
      // follows repaints its own (lower) footprint; survivors sit above it.
      let out = '';
      for (let r = Math.max(1, this.committedBandTopRow); r <= this.committedBandBottomRow; r++) {
        out += `\x1b[${r};1H\x1b[2K`;
      }
      for (let i = 0; i < bandLen; i++) {
        out += `\x1b[${1 + i};1H\x1b[2K${this.committedBand[i] ?? ''}`;
      }
      try {
        this.stdout.write(out);
      } catch {
        /* terminal closed mid-render — next render's lifecycle tears us down */
      }
      this.evictRowsToScrollback(overflow);
      // Survivors physically shifted to [1, room] by the scroll — already
      // hugging the new frame top (room === desiredTopRow - 1). Record that so a
      // later shrink re-pins from the right place.
      this.committedBand = this.committedBand.slice(overflow);
      this.committedBandTopRow = 1;
      this.committedBandBottomRow = room;
      return;
    }

    // Banner present (anchorRow > 1): legacy deficit-based eviction, unchanged.
    const growthDeficit = (this.hasCommitted && prevTopRow > 1) ? Math.max(0, prevTopRow - desiredTopRow) : 0;
    // Anchor-row enforcement (legacy ceiling): never let the frame top climb
    // above a supplied pre-arm ceiling (welcome banner / update notice)
    // without first preserving the rows down to it.
    const anchorDeficit =
      desiredTopRow < this.anchorRow! ? this.anchorRow! - desiredTopRow : 0;
    const deficit = Math.max(growthDeficit, anchorDeficit);
    if (deficit > 0) {
      this.evictRowsToScrollback(deficit);
      // Everything (including pre-arm content) scrolled up by `deficit`, so the
      // safe ceiling moves up the same amount. Clamp at 1; once the banner has
      // fully scrolled into scrollback there is nothing left to protect.
      if (this.anchorRow !== undefined && this.anchorRow > 1) {
        this.anchorRow = Math.max(1, this.anchorRow - deficit);
      }
      // The committed band scrolled up by the same `deficit` (a small growth —
      // e.g. the spinner appearing — does NOT push it off-screen; it stays in
      // the viewport, one row higher). Shift its tracked rows so a later shrink
      // re-pins at the right screen position. Drop only the lines that crossed
      // ABOVE the anchor floor into terminal scrollback, so the re-pin never
      // paints scrolled-away content back into the viewport (which would
      // duplicate what the terminal already holds in scrollback).
      if (this.committedBand.length > 0) {
        this.committedBandTopRow -= deficit;
        this.committedBandBottomRow -= deficit;
        const floor = Math.max(this.anchorRow ?? 1, 1);
        if (this.committedBandTopRow < floor) {
          const lost = floor - this.committedBandTopRow;
          this.committedBand = this.committedBand.slice(lost);
          this.committedBandTopRow = floor;
        }
        if (this.committedBand.length === 0 || this.committedBandBottomRow < floor) {
          this.clearCommittedBand();
        }
      }
    }
  }

  /**
   * Push `rows` rows of viewport content into the terminal's scrollback
   * buffer by emitting `\n` writes at the bottom row of the active DECSTBM
   * region. Each `\n` at the bottom margin triggers a one-row scroll-up;
   * the top row of the scroll region is preserved in scrollback (terminal-
   * native). When a {@link CompositorScrollRegionGuard} (typically the
   * StatusLine) is wired, the eviction runs inside `withFullScrollRegion`
   * so the scroll happens against the full screen height rather than the
   * status-line's reserved sub-region — matching the contract `commitAbove`
   * already follows for the same reason.
   *
   * No-op when `rows <= 0`. Best-effort on stdout write failure (terminal
   * may have closed between repaint() and this call).
   */
  private evictRowsToScrollback(rows: number): void {
    if (rows <= 0) return;
    this.debugLog('evict:enter', { rows, anchorRow: this.anchorRow ?? null });
    // Invariant (DECSTBM scroll trigger): a `\n` scrolls the region only when
    // the cursor sits AT the bottom margin. Under withFullScrollRegion (and the
    // no-scrollRegion default) that margin is the physical last row
    // (this.stdout.rows). CUP there — NOT to targetBottomRow (rows-1-extraRows),
    // which sits one-or-more rows ABOVE the margin, so the first `\n`(s) would
    // merely move the cursor down without scrolling, yielding fewer than `rows`
    // scrolls and letting the growing frame overwrite the committed content
    // this eviction exists to preserve (review #592 BLOCKER-2). Safe even with a
    // status line: withFullScrollRegion forces the full-screen region and
    // repaints the status row afterward.
    const physicalBottom = Math.max(1, this.stdout.rows ?? 24);
    const escape = `\x1b[${physicalBottom};1H${'\n'.repeat(rows)}`;
    const doWrite = (): void => {
      try {
        this.stdout.write(escape);
      } catch (err) {
        this.debugLog('evict:error', { msg: (err as Error)?.message ?? String(err) });
        // Stdout may be closed mid-render (process exit, terminal hangup);
        // the next render() call will fail too and the surface lifecycle
        // will tear us down — nothing more we can do here.
      }
    };
    if (this.scrollRegion !== undefined) {
      this.scrollRegion.withFullScrollRegion(doWrite);
    } else {
      doWrite();
    }
  }

  /**
   * Picker-mode repaint. Stacks overlay/spinner/tip/attachment chrome
   * (if any) above a one-row gap, then appends the picker's rendered
   * rows at the bottom. The compositor's input buffer + dropdown + hint
   * rows are deliberately suppressed — the picker owns that region.
   *
   * Mirrors the viewport-budget + gap-row logic from `repaint()` so
   * the picker frame degrades gracefully when chrome + picker rows
   * exceed the viewport height (oldest overlay lines drop first).
   *
   * Invariant: the picker's last `renderRows()` entry is the
   * bottom-pinned row. `frameLines.push(...pickerRows)` preserves
   * the controller's intended ordering top→bottom.
   */
  private repaintPickerFrame(): void {
    if (!this.logUpdate || !this.pickerController) return;
    const pickerRows = [...this.pickerController.renderRows()];
    const overlayLines = this.overlay ? this.overlay.split('\n') : [];
    const spinnerRow = this.spinnerController.renderSpinnerRow();
    const tipRow = this.spinnerController.renderTipRow(this.stdout.columns ?? 80);
    let attachmentRow: string | null = null;
    if (this.attachments.length > 0) {
      attachmentRow = renderStatusLine(this.attachments);
    } else if (this.clipboardFailureMsg !== null) {
      attachmentRow = palette.dim(this.clipboardFailureMsg);
      this.clipboardFailureMsg = null;
    }
    const hasFixedChrome = !!spinnerRow || !!tipRow || !!attachmentRow;
    const hasContentAboveInput = hasFixedChrome || overlayLines.length > 0;
    // Invariant: the bg status bar (when active) owns rows (rows-extraRows)..(rows-1).
    // Compositor frame must stay above that region or the two writers race the same physical row
    // every spinner tick, producing flicker. Mirrors DECSTBM math in status-line.ts:287.
    const extraRows = this.scrollRegion?.getExtraRows() ?? 0;
    const maxLines = Math.max(1, (this.stdout.rows ?? 24) - 1 - extraRows);
    const gapRows = hasContentAboveInput ? 1 : 0;
    const fixedRows = (spinnerRow ? 1 : 0) + (tipRow ? 1 : 0)
      + (attachmentRow ? 1 : 0) + gapRows + pickerRows.length;
    const overlayBudget = Math.max(0, maxLines - fixedRows);
    const trimmedOverlay = overlayLines.length > overlayBudget
      ? overlayLines.slice(-overlayBudget)
      : overlayLines;
    const renderGap = hasFixedChrome || trimmedOverlay.length > 0;
    const frameLines: string[] = [];
    frameLines.push(...trimmedOverlay);
    if (spinnerRow) frameLines.push(spinnerRow);
    if (tipRow) frameLines.push(tipRow);
    if (attachmentRow) frameLines.push(attachmentRow);
    if (renderGap) frameLines.push('');
    frameLines.push(...pickerRows);
    // Empty-frame guard: when the picker's renderRows() is empty and no
    // chrome is active, frameLines is []. The CupFrameRenderer clamps
    // rawLineCount to ≥1, so rendering an empty string would violate the
    // padded-covers-raw invariant added in PR #557 (lineCount=0 <
    // rawLineCount=1). Skip the render — nothing to draw on screen.
    if (frameLines.length === 0) return;
    const targetBottomRow = Math.max(1, (this.stdout.rows ?? 24) - 1 - extraRows);
    const frame = frameLines.join('\n');
    // Wrap-aware top row — CupFrameRenderer hard-wraps at stdout.columns; sizing
    // the band off the logical line count re-pins it inside a soft-wrapped frame
    // (review #592). See repaint() for the full rationale.
    const desiredTopRow = this.logUpdate.measure
      ? this.logUpdate.measure(frame, targetBottomRow).topRow
      : Math.max(1, targetBottomRow - frameLines.length + 1);
    this.preserveRowsBeforeFrameRender(desiredTopRow);
    const preRenderFrameTop = this.logUpdate.topRow ?? 0;
    this.logUpdate.render(frame, targetBottomRow);
    this.repositionCommittedBand(desiredTopRow, preRenderFrameTop, targetBottomRow);
  }

  private resetState(): void {
    this.overlay = '';
    this.input = InputCore.seed('');
    this.queued = false;
    this.canceled = false;
    this.backgrounded = false;
    this.softStopped = false;
    // Clear active ghost — stale suggestions must not survive a disarm/rearm
    // cycle. The engine itself is NOT disposed here (only in disarm) since
    // resetState() is called by both disarm() AND internal state-resets that
    // keep the engine alive (e.g. idle→streaming transition after submit).
    this.activeGhost = null;
    // Clear the working anchor — `repaint()` may have shifted it up during
    // eviction (e.g. declared 15 → working 11 after pushing 4 rows into
    // scrollback). The shifted value is per-cycle state; leaving it set
    // across disarm/rearm would silently under-protect the declared ceiling
    // on the next arm. `arm()` re-seeds from `declaredAnchorRow`.
    this.anchorRow = undefined;
    // Reset commit-presence flag so growthDeficit in repaint() does not fire
    // on the new arm cycle until a commit actually happens.
    this.hasCommitted = false;
    // Drop any retained above-frame committed block + the in-flight commit guard
    // so a fresh arm cycle never re-pins stale transcript from the previous one.
    this.clearCommittedBand();
    this.commitInFlight = false;
    // Drop resize ghost-erase state — a pending erase or stale row count from
    // the previous arm cycle must not leak into the next one (the first repaint
    // of a fresh arm re-seeds lastKnownRows before any resize can be detected).
    this.pendingResizeErase = null;
    this.lastKnownRows = 0;
    // Drop any active picker — a disarm during a picker would leave
    // the controller's resolve callback orphaned. The runPicker abort
    // path normally exits the picker first; this is defence-in-depth
    // for a hard disarm (process termination, swap path).
    this.pickerController = null;
    this.inputMode = 'streaming';
    // Reset attachment + paste state — between full disarm/rearm cycles
    // (skill dispatchers, tests) we must not carry stale clipboard
    // artifacts into the next session.
    this.attachments = [];
    this.pasting = false;
    this.pasteStartBufferLen = 0;
    this.pasteStartCursor = 0;
    this.pasteRegistry.clear();
    this.clipboardFailureMsg = null;
    // clipboardInFlight is NOT reset — an in-flight osascript probe is
    // tied to a Promise that will resolve/reject independently. Setting
    // the flag to false here would allow a new probe to spawn while the
    // old one's `.finally` is pending, defeating the guard.
    // Reset shared autocomplete state so stale dropdown chrome from this
    // agent turn does not leak into the next user-turn read.
    this.autocompleteState?.reset();
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    if (this.resizeImmediateUnsub) {
      this.resizeImmediateUnsub();
      this.resizeImmediateUnsub = null;
    }
  }

  /**
   * Apply a pure InputCore transition. If the state reference changed, clear
   * the queued flag, refresh the autocomplete state, and repaint; otherwise
   * it's a no-op (e.g. moveLeft at 0).
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  applyEdit(next: InputCoreState): boolean {
    if (next === this.input) return false;
    this.input = next;
    this.queued = false;
    // During a bracketed-paste burst, suppress per-character work —
    // a 10KB paste would otherwise trigger 10K log-update frames AND
    // 10K detectTrigger scans. The paste end marker (`\x1b[201~`)
    // runs maybeTruncatePaste + one final repaint, which also picks
    // up any autocomplete state from the final buffer. Mirrors the
    // `pasting` guard in reader.ts and keeps multi-KB pastes responsive.
    if (this.pasting) return true;
    this.updateAutocomplete();
    // Ghost-text update: synchronous Tier-1 check + async Tier-2 kick-off.
    // Paste bursts already returned early above (the `if (this.pasting)`
    // guard), so this per-character ghost refresh never fires mid-paste —
    // it would be stale by paste end anyway.
    this.updateGhost();
    this.repaint();
    return true;
  }

  /**
   * Apply the currently highlighted dropdown candidate to the buffer. Body
   * extracted to terminal-compositor.autocomplete.ts — see
   * {@link Autocomplete.applyDropdownSelection}. Returns `true` when a
   * candidate was applied, `false` when the dropdown is closed/empty.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  applyDropdownSelection(): boolean {
    return Autocomplete.applyDropdownSelection(this);
  }

  /**
   * Accept the current ghost text (replace buffer with the full ghost, cursor
   * to end, clear ghost, repaint). Body extracted to
   * terminal-compositor.autocomplete.ts — see {@link Autocomplete.applyGhostAccept}
   * for the accept preconditions. Returns `true` when a ghost was accepted.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  applyGhostAccept(): boolean {
    return Autocomplete.applyGhostAccept(this);
  }

  /**
   * Per-keystroke dispatch entry point — the ordered guard-chain. Body
   * extracted to terminal-compositor.input-dispatch.ts; see
   * {@link InputDispatch.dispatchKey} for the strict handler ORDER (which IS
   * the input contract) and each handler's inline ordering rationale. The
   * keypress listener installed in {@link arm} calls this delegator; the
   * input-dispatch module owns the 12 ordered leaf handlers.
   */
  private dispatchKey(char: string | undefined, key: KeyInfo): void {
    InputDispatch.dispatchKey(this, char, key);
  }
}
