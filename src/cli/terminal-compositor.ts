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
import { CaretBlinkController, DEFAULT_CARET_BLINK_INTERVAL_MS } from './input/caret-blink.js';
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
import * as InputDispatch from './terminal-compositor.input-dispatch.js';
import * as Lifecycle from './terminal-compositor.lifecycle.js';
import * as Reset from './terminal-compositor.reset.js';

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
  /**
   * Per-turn pause-interrupt handler — see
   * {@link TerminalCompositorOptions.onPauseInterrupt}. Invoked when the user
   * submits a line while {@link paused} is true; ends the usage-limit wait so
   * the queued buffer flushes as the next turn.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  onPauseInterrupt?: () => void;
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
  /**
   * True while the current turn is parked in a usage-limit pause (set by the
   * turn handler on the `paused` provider event, cleared on `resumed` / turn
   * end). While set, a submitted line in {@link handleEnter} additionally
   * fires {@link onPauseInterrupt} so the queued buffer is not stranded behind
   * the auto-resume wait. Reset in `resetState()` (defence-in-depth).
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  paused = false;
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
  /**
   * `true` IFF {@link pendingSubmissions} is non-empty — a maintained mirror
   * kept in sync at every queue mutation. Read by the renderer (the
   * `[queued]` / `[N queued]` suffix) and {@link getBuffer}. Stored as a plain
   * boolean (not a getter) so the sibling Host-interface field shape is
   * unchanged.
   * @internal Relaxed from `private` — read/written by sibling free-function modules via Host interfaces.
   */
  queued = false;
  /**
   * FIFO queue of messages the user typed + Entered mid-turn (streaming mode).
   * Each Enter commits the live buffer here and clears the input so the next
   * message composes fresh; the queue drains one payload per turn when the
   * surface flips to `'idle'` (see the flush in
   * `./terminal-compositor.input-mode.ts`). Payloads are self-contained —
   * paste placeholders are expanded and attachments snapshotted at commit
   * time, so a queued message never depends on later live-buffer state.
   * Reset by `resetState()`.
   * @internal Relaxed from `private` — read/written by sibling free-function modules via Host interfaces.
   */
  pendingSubmissions: SubmissionPayload[] = [];

  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  handleKeypress: ((char: string | undefined, key: KeyInfo) => void) | null = null;
  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  resizeUnsub: (() => void) | null = null;
  /** @internal Relaxed from `private` for the lifecycle module (LifecycleHost). */
  resizeImmediateUnsub: (() => void) | null = null;

  /** @internal Relaxed from `private` for the frame module (FrameHost). */
  readonly spinnerController: SpinnerController;
  /**
   * Owns the input caret's blink phase + timer. Started in arm() / resumeInput(),
   * stopped in disarm() / suspendInput(), reset-to-solid on each non-paste
   * keystroke. `caretVisible` (read by the frame renderer) reflects its phase.
   * @internal Relaxed from `private` for the lifecycle module (LifecycleHost).
   */
  readonly caretBlinkController: CaretBlinkController;
  /**
   * Monotonic frame counter, bumped once per {@link repaint}. Read by the
   * lifecycle keypress handler (`LifecycleHost.repaintCount`) to tell whether
   * dispatchKey already painted a frame this keystroke, so the caret-blink
   * un-hide repaint is issued only when nothing else painted — avoiding a double
   * frame on an off-phase keystroke. Plain counter; wraparound is unreachable in
   * a session (Number.MAX_SAFE_INTEGER frames).
   * @internal Relaxed from `private` for the lifecycle module (LifecycleHost).
   */
  repaintCount = 0;
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
  // Invariant: committedBandPaintedRows counts how many of committedBand's rows
  // are MATERIALIZED on the terminal right now — always the BOTTOM
  // committedBandPaintedRows rows (nearest the frame), since every paint site
  // (commitAbove Phase 3, repositionCommittedBand, preserveRowsBeforeFrameRender)
  // CUP-paints the band's suffix. The complementary PREFIX
  // committedBand.slice(0, length - committedBandPaintedRows) is PENDING: held
  // only in this in-memory model, never written to the terminal and never
  // archived to scrollback. The band-hold storage branch in commitAbove (taken
  // when a block is committed under a full-viewport overlay, newTopRow <= 1)
  // sets this to 0 — the whole block is pending until repositionCommittedBand
  // paints it on collapse. disarm() reads this to flush only the genuinely
  // unpainted prefix into scrollback before tearing down (the painted suffix is
  // already on screen, so re-emitting it would duplicate it). Always satisfies
  // 0 <= committedBandPaintedRows <= committedBand.length; reset to 0 by
  // clearCommittedBand() and (transitively) resetState().
  /** @internal Relaxed from `private` for the committed-band module (CommittedBandHost). */
  committedBandPaintedRows = 0;
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
    this.onPauseInterrupt = opts.onPauseInterrupt;
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
      goblin: opts.goblinSpinner ?? false,
      onTick: () => this.repaint(),
    });
    // Caret blink defaults OFF: enablement (incl. reduced-motion) is resolved
    // by the interactive caller and passed as `caretBlink`, mirroring how the
    // spinner's motion gating is resolved caller-side (stream-renderer). This
    // keeps every direct/test construction free of an auto-started recurring
    // timer. captureMode suppresses the ticker even when enabled.
    this.caretBlinkController = new CaretBlinkController({
      enabled: opts.caretBlink ?? false,
      captureMode: opts.captureMode ?? false,
      intervalMs: opts.caretBlinkIntervalMs ?? DEFAULT_CARET_BLINK_INTERVAL_MS,
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

  /**
   * Snapshot the current buffer as submission-shaped text + the queued flag.
   * Body extracted to terminal-compositor.paste.ts — see {@link Paste.getBuffer}
   * for the placeholder-expansion semantics and the post-submit caution.
   */
  getBuffer(): { text: string; queued: boolean } {
    return Paste.getBuffer(this);
  }

  /**
   * Number of messages queued for submission — typed + Entered during a
   * streaming turn and not yet drained. 0 between turns once the queue
   * empties. Surfaced for tests and any caller that wants to show queue depth.
   */
  getPendingCount(): number {
    return this.pendingSubmissions.length;
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

  /**
   * Whether the caret glyph is in its visible phase this frame. Read by the
   * frame renderer (RenderHost.caretVisible) to paint a solid vs. blanked
   * caret. Always true unless the caret-blink ticker is running and currently
   * in its off-phase. @internal Relaxed for the render module (RenderHost).
   */
  get caretVisible(): boolean {
    return this.caretBlinkController.visible;
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
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  updateGhost(): void {
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
    // Bump BEFORE painting so the lifecycle keypress handler's post-dispatch
    // comparison sees the increment from any repaint dispatchKey triggered.
    this.repaintCount++;
    Frame.repaint(this);
  }

  /**
   * Clear the terminal viewport and repaint the live frame (Ctrl+L binding).
   *
   * // Invariant: the physical erase MUST precede repaint(). log-update's
   * // CupFrameRenderer tracks the last rendered frame's top row; if repaint()
   * // fires before the erase, it will attempt to cursor-up to a stale row
   * // position on a screen that has already been cleared, producing garbled
   * // output. The sequence is: (1) reset log-update geometry so the next
   * // render() treats the screen as clean, (2) write the erase sequences to
   * // stdout, (3) call repaint() which then paints at the correct (0,0) origin.
   * // resetGeometry() is optional (absent on test stubs); if absent, the
   * // erase-then-repaint still works — CupFrameRenderer simply erases the
   * // stale ghost region before drawing. Mirrors reader.ts:566-576.
   * @internal Public for the input-dispatch module (KeyDispatchHost).
   */
  clearScreen(): void {
    // Step 1: drop tracked geometry so the next render starts from row 0.
    this.logUpdate?.resetGeometry?.();
    // Step 2: cursor home + erase entire screen (viewport only — no scrollback
    // wipe here, unlike the /clear slash command which also sends CSI 3J).
    this.stdout.write('\x1b[H\x1b[2J');
    // Step 3: repaint the live frame at the now-clean origin.
    this.repaint();
  }

  /**
   * Reset all per-cycle state back to its armed-cycle defaults (overlay, input,
   * paste/attachment, committed-band, resize ghost-erase, picker). Body extracted
   * to terminal-compositor.reset.ts — see {@link Reset.resetState} for the
   * per-field disarm/rearm invariants (working-anchor clear, ghost-not-engine,
   * and the clipboardInFlight + committed-band carve-outs).
   * @internal Relaxed from `private` for the lifecycle module (LifecycleHost).
   */
  resetState(): void {
    Reset.resetState(this);
  }

  /**
   * Apply a pure InputCore transition (clears queued, refreshes autocomplete +
   * ghost, repaints; no-op when the state reference is unchanged). Body extracted
   * to terminal-compositor.input-dispatch.ts — see {@link InputDispatch.applyEdit}
   * for the bracketed-paste per-character suppression guard.
   * @internal Relaxed from `private` for the input-dispatch module (KeyDispatchHost).
   */
  applyEdit(next: InputCoreState): boolean {
    return InputDispatch.applyEdit(this, next);
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
