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

import { env } from '../config/env.js';
import { palette } from './palette.js';
import { InputCore, type InputCoreState } from './input-core.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { IHistoryRing } from './input/types.js';
import type { ImageAttachment } from './input/attachments.js';
import { SpinnerController } from './input/spinner.js';
import type { StdinClaimHandle } from './input/stdin-claim.js';
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
import * as Frame from './terminal-compositor.frame.js';
import * as InputMode from './terminal-compositor.input-mode.js';
import * as Lifecycle from './terminal-compositor.lifecycle.js';

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
  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  readonly stdin: NodeJS.ReadStream;
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
  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  declaredAnchorRow: number | undefined;

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
   * @internal Relaxed from `private` for the input-mode module (InputModeHost).
   */
  pickerSavedMode: CompositorInputMode = 'streaming';

  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  armed = false;
  /** @internal Relaxed from `private` for the frame module (FrameHost). */
  suspended = false;  // true while suspendInput() is in effect
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  canceled = false;
  /** @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost). */
  backgrounded = false;
  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  wasRaw = false;
  /** Held while armed; released on disarm().
   * @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  stdinClaim: StdinClaimHandle | null = null;
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  logUpdate: LogUpdateFn | null = null;

  /** @internal Relaxed from `private` for the frame module (FrameHost). */
  overlay = '';
  /** @internal Relaxed from `private` — read/written by sibling free-function modules via Host interfaces. */
  input: InputCoreState = InputCore.seed('');
  /** @internal Relaxed from `private` — read/written by sibling free-function modules via Host interfaces. */
  queued = false;

  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  handleKeypress: ((char: string | undefined, key: KeyInfo) => void) | null = null;
  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  resizeUnsub: (() => void) | null = null;
  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  resizeImmediateUnsub: (() => void) | null = null;

  /** @internal Relaxed from `private` for the frame module (FrameHost). */
  readonly spinnerController: SpinnerController;
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
  // Content COVERED by a full-viewport frame (desiredTopRow ≤ 1) rather than
  // displayed: when the overlay fills the screen there is no above-frame row to
  // show the committed band, but the overlay is transient. Stashing the most-
  // recent committed block here (instead of dropping it) lets
  // repositionCommittedBand re-pin it adjacent to the frame the moment the
  // overlay collapses — otherwise the band is empty on collapse and
  // CupFrameRenderer shrink-pads blank rows that nothing refills (the "massive
  // blank gap"). Invalidated whenever an on-screen band is (re-)established or
  // the band is reset (clearCommittedBand). See repositionCommittedBand().
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  coveredBand: string[] = [];

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
  /** @internal Relaxed from `private` for the frame module (FrameHost). */
  lastKnownRows = 0;
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
   * elicitation handler) can receive keystrokes cleanly. Body extracted
   * to terminal-compositor.lifecycle.ts — see {@link Lifecycle.suspendInput}.
   *
   * The compositor remains "armed" (armed=true) throughout — `resumeInput()`
   * restores the listener and raw mode without going through the full
   * arm/disarm cycle. Idempotent: calling when already suspended is a
   * no-op. Must be paired with a matching `resumeInput()`.
   */
  suspendInput(): void {
    Lifecycle.suspendInput(this);
  }

  /**
   * Restore the keypress listener and raw mode after a `suspendInput()`
   * call. Body extracted to terminal-compositor.lifecycle.ts — see
   * {@link Lifecycle.resumeInput}. Idempotent: calling when not suspended
   * is a no-op.
   */
  resumeInput(): void {
    Lifecycle.resumeInput(this);
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
   * {@link PickerController}. Body extracted to
   * terminal-compositor.input-mode.ts — see {@link InputMode.enterPickerMode}.
   *
   * @throws if a picker is already active (callers must `exitPickerMode`
   * before installing a new controller).
   */
  enterPickerMode(controller: PickerController): void {
    InputMode.enterPickerMode(this, controller);
  }

  /**
   * Exit picker mode and restore the previous input mode. Body extracted to
   * terminal-compositor.input-mode.ts — see {@link InputMode.exitPickerMode}.
   *
   * No-op when no picker is active (idempotent — safe to call from
   * cleanup paths that don't know whether `enterPickerMode` was reached).
   */
  exitPickerMode(): void {
    InputMode.exitPickerMode(this);
  }

  /**
   * Force a repaint while the picker is active. Body extracted to
   * terminal-compositor.input-mode.ts — see {@link InputMode.repaintPicker}.
   *
   * No-op when no picker is active (defence-in-depth — a late repaint
   * from a cancelled picker won't double-render the input row).
   */
  repaintPicker(): void {
    InputMode.repaintPicker(this);
  }

  /**
   * Transition input mode. Default is `'streaming'`; the persistent
   * InputSurface flips to `'idle'` between turns and back to
   * `'streaming'` at turn start. Body extracted to
   * terminal-compositor.input-mode.ts — see {@link InputMode.setInputMode}
   * for the full ordered-operation and flush-semantics invariants.
   */
  setInputMode(mode: CompositorInputMode): void {
    InputMode.setInputMode(this, mode);
  }

  /**
   * Current input mode. Surfaced for tests + the InputSurface idle
   * check. Body extracted to terminal-compositor.input-mode.ts —
   * see {@link InputMode.getInputMode}.
   */
  getInputMode(): CompositorInputMode {
    return InputMode.getInputMode(this);
  }

  /**
   * Acquire raw mode + keypress listener + resize subscribers and render
   * the first frame. Body extracted to terminal-compositor.lifecycle.ts —
   * see {@link Lifecycle.arm} for the full arm-ordering invariant and
   * SIGWINCH ghost-erase rationale.
   */
  async arm(): Promise<void> {
    return Lifecycle.arm(this);
  }

  /**
   * Release raw mode + keypress listener + resize subscribers, finalize
   * the frame, and reset state. Body extracted to
   * terminal-compositor.lifecycle.ts — see {@link Lifecycle.disarm} for
   * the drain-ordering and suggest-engine-dispose invariants.
   */
  disarm(): void {
    Lifecycle.disarm(this);
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

  /** @internal Relaxed from `private` for the frame module (FrameHost). */
  clearCommittedBand(): void {
    CommittedBand.clearCommittedBand(this);
  }

  /**
   * Physically erase the pre-resize on-screen footprint snapshotted by the
   * SIGWINCH immediate handler. Body extracted to
   * terminal-compositor.committed-band.ts — see {@link CommittedBand.flushResizeGhostErase}.
   *
   * @internal Relaxed from `private` for the frame module (FrameHost).
   */
  flushResizeGhostErase(): void {
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
   *
   * @internal Relaxed from `private` for the frame module (FrameHost).
   */
  repositionCommittedBand(
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
  /** @internal Relaxed from `private` for the frame module (FrameHost). */
  renderInputLine(): string {
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
   *
   * @internal Relaxed from `private` for the frame module (FrameHost).
   */
  renderDropdownRows(): string[] {
    return Render.renderDropdownRows(this);
  }

  /**
   * Render the selected-candidate `↳ <when-to-use>` hint row. Body extracted
   * to terminal-compositor.render.ts — see {@link Render.renderHintRow} for
   * the frame-height-stability invariant (always non-null while the dropdown
   * is open, so the row count stays constant across ↑/↓ navigation).
   *
   * @internal Relaxed from `private` for the frame module (FrameHost).
   */
  renderHintRow(): string | null {
    return Render.renderHintRow(this);
  }

  /** @internal Public for sibling free-function modules (via Host interfaces) and test casts. */
  repaint(): void {
    Frame.repaint(this);
  }

  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  resetState(): void {
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

}
