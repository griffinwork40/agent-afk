/**
 * Lifecycle — arm/disarm/suspendInput/resumeInput, extracted from
 * terminal-compositor.ts (free-functions-on-host pattern; see sibling
 * render/committed-band/input-mode modules). The class owns all state; these
 * mutate the narrow {@link LifecycleHost} slice passed as `self`. arm()'s
 * keypress listener calls `InputDispatch.dispatchKey(self, …)` directly so
 * `dispatchKey` stays private on the class.
 */

import { CupFrameRenderer } from './cup-frame-renderer.js';
import { emitKeypressEventsImmediateEscape } from './input/emit-keypress.js';
import { acquireStdinClaim, type StdinClaimHandle } from './input/stdin-claim.js';
import { ResizeBus } from './terminal-size.js';
import type { SpinnerController } from './input/spinner.js';
import type { CaretBlinkController } from './input/caret-blink.js';
import type { SuggestEngine } from './terminal-compositor.types.js';
import type {
  BandRowMeta,
  CompositorScrollRegionGuard,
  KeyInfo,
  LogUpdateFn,
} from './terminal-compositor.types.js';
import { scrollbackFlushLines, buildScrollbackArchiveEscape, eraseAndPaintRow } from './terminal-compositor.scrollback.js';
import * as InputDispatch from './terminal-compositor.input-dispatch.js';
import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';

/**
 * Narrowest TerminalCompositor state slice the lifecycle functions touch.
 * Field semantics are documented authoritatively on the class declarations
 * in terminal-compositor.ts; this interface is a structural mirror (same
 * minimal style as RenderHost). `repaint`/`resetState` are class methods the
 * functions call back into.
 */
export interface LifecycleHost {
  repaint(): void;
  resetState(): void;

  /**
   * Monotonic frame counter — bumped once per {@link repaint}. Read by arm()'s
   * keypress handler to detect whether dispatchKey already painted a frame this
   * keystroke, so the caret-blink un-hide repaint fires only when nothing else
   * did (avoids a double frame on an off-phase keystroke).
   */
  readonly repaintCount: number;

  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;

  armed: boolean;
  suspended: boolean;
  wasRaw: boolean;
  stdinClaim: StdinClaimHandle | null;
  handleKeypress: ((char: string | undefined, key: KeyInfo) => void) | null;
  resizeUnsub: (() => void) | null;
  resizeImmediateUnsub: (() => void) | null;

  logUpdate: LogUpdateFn | null;
  readonly scrollRegion?: CompositorScrollRegionGuard;

  anchorRow: number | undefined;
  declaredAnchorRow: number | undefined;
  canceled: boolean;

  readonly spinnerController: SpinnerController;
  readonly caretBlinkController: CaretBlinkController;
  readonly ghostEngine: SuggestEngine | undefined;

  // Resize ghost-erase state + committed-band rows: read by arm()'s immediate
  // SIGWINCH subscriber to snapshot the pre-resize footprint for erase.
  lastKnownRows: number;
  pendingResizeErase: { top: number; bottom: number } | null;
  readonly committedBand: string[];
  // #540: per-physical-row logical provenance, index-aligned 1:1 with
  // committedBand. Read by flushPendingCommittedBand to archive the pending
  // prefix as soft-wrappable logical lines instead of pre-wrapped physical rows.
  readonly committedBandMeta: BandRowMeta[];
  readonly committedBandTopRow: number;
  // #540 Stage 3: bottom row of the on-screen painted band suffix. Read by
  // endTurnFlush to determine the erase range for painted rows.
  readonly committedBandBottomRow: number;
  // Read by disarm() to flush genuinely-unpainted committed-band rows to
  // scrollback before teardown. See committedBandPaintedRows on the class.
  readonly committedBandPaintedRows: number;
  // F2: set by the SIGWINCH-immediate handler; cleared by the next debounced
  // repaint once repositionCommittedBand re-establishes real geometry. See the
  // field doc on the class (terminal-compositor.ts).
  bandGeometryStale: boolean;
  // #540 Stage 3: clear the committed band after a full end-of-turn flush.
  clearCommittedBand(): void;
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
export function suspendInput(self: LifecycleHost): void {
  if (!self.armed || self.suspended) return;
  // Clear the live overlay so the compositor frame doesn't visually
  // compete with the readline prompt that is about to appear below it.
  if (self.logUpdate) {
    try { self.logUpdate.clear(self.scrollRegion?.getExtraRows() ?? 0); self.logUpdate.done(); } catch { /* noop */ }
  }
  if (self.handleKeypress) {
    self.stdin.removeListener('keypress', self.handleKeypress);
  }
  try { self.stdin.setRawMode(false); } catch { /* noop */ }
  // Pause the blink while an external readline (e.g. elicitation) owns the TTY
  // — its own cursor takes over; resumeInput() restarts the ticker.
  self.caretBlinkController.stop();
  self.suspended = true;
}

/**
 * Restore the keypress listener and raw mode after a `suspendInput()`
 * call. Idempotent: calling when not suspended is a no-op.
 */
export function resumeInput(self: LifecycleHost): void {
  if (!self.armed || !self.suspended) return;
  try { self.stdin.setRawMode(true); } catch { /* noop */ }
  if (self.handleKeypress) {
    self.stdin.on('keypress', self.handleKeypress);
  }
  self.suspended = false;
  self.repaint();
  // Resume blinking now that we hold the TTY again. No-op when disabled.
  self.caretBlinkController.start();
}

// Contract: arm() installs a keypress listener that calls InputDispatch.dispatchKey(self, ...).
// The `self` parameter must therefore satisfy both LifecycleHost (for lifecycle state) and
// KeyDispatchHost (for the dispatch call). The intersection type enforces this at the call site
// (TerminalCompositor satisfies both) without relaxing dispatchKey on the class or polluting
// LifecycleHost with dispatch-specific fields.
export async function arm(self: LifecycleHost & KeyDispatchHost): Promise<void> {
  if (self.armed) throw new Error('TerminalCompositor: arm() called while already armed');

  if (!self.stdout.isTTY || !self.stdin.isTTY) {
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
  self.anchorRow = self.declaredAnchorRow;

  if (!self.logUpdate) {
    self.logUpdate = new CupFrameRenderer(self.stdout) as unknown as LogUpdateFn;
  }

  // Invariant (claim-before-mutate): take the stdin claim BEFORE raw mode /
  // bracketed-paste — a conflict then rejects arm() with nothing to roll back.
  self.stdinClaim = acquireStdinClaim('TerminalCompositor.arm');

  self.wasRaw = self.stdin.isRaw ?? false;
  try {
    self.stdin.setRawMode(true);
  } catch {
    // setRawMode failed — release the claim so it doesn't leak, then bail.
    self.stdinClaim?.release();
    self.stdinClaim = null;
    self.logUpdate = null;
    self.wasRaw = false;
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
    // Enable bracketed paste + scroll-to-bottom-on-keypress in one write.
    // \x1b[?2004h  = bracketed-paste mode (see above).
    // \x1b[?1011h  = rxvt scrollKey — tells the terminal to snap the
    //   viewport to the bottom of scrollback whenever the user presses a
    //   key. Default-on in every major terminal (iTerm2, kitty, Terminal.app,
    //   WezTerm, Alacritty, Ghostty, GNOME Terminal), so this is a no-op for
    //   most users; it covers the edge case where the terminal or the user's
    //   config has the mode off (xterm scrollKey resource, Ghostty
    //   `scroll-to-bottom` setting). Without it, a user scrolled up into
    //   history can type without the viewport snapping back to the input line.
    //   Disabled in disarm() to restore the prior terminal state.
    self.stdout.write('\x1b[?2004h\x1b[?1011h');
  } catch {
    /* best-effort — terminals that don't support DEC private modes
       silently drop unknown set/reset sequences, so a thrown write
       likely means stdout was closed mid-arm. */
  }
  self.stdin.resume();
  // Lone ESC must register on the first press — it is the soft-stop
  // affordance. emitKeypressEventsImmediateEscape sets a small sub-perception
  // escapeCodeTimeout (Node's default 500ms keyseq-timeout is the "ESC needs
  // two presses" bug; see emit-keypress.ts for why nonzero). The decoder is
  // idempotent per stream, so the first surface to attach it (this,
  // reader.ts, elicitation-repl.ts) locks the timeout in; all of them call
  // the helper with the same value, so it wins regardless of order.
  emitKeypressEventsImmediateEscape(self.stdin);

  // Contract: dispatchKey is private on TerminalCompositor and is not
  // surfaced in LifecycleHost. The keypress listener calls InputDispatch.dispatchKey
  // directly (with `self` as the KeyDispatchHost) so no relaxation of
  // dispatchKey is needed and no circular dependency is introduced.
  //
  // Caret-blink reset: a deliberate keystroke snaps the caret back to solid and
  // restarts the blink dwell window, mirroring terminal cursor behavior (steady
  // while typing, blinks only when idle). Skipped mid-paste-burst (`self.pasting`
  // is set by handlePasteMarkers on the `\x1b[200~` open marker) — a 10K-char
  // paste would otherwise churn the interval per character with no visible
  // benefit, and applyEdit already suppresses per-char repaints during a burst.
  //
  // Repaint coalescing: resetVisible() only mutates phase state and REPORTS
  // whether it un-hid an off-phase caret — it does not paint. Almost every key
  // dispatchKey handles repaints anyway (applyEdit, nav, dropdown…), and that
  // frame already reflects the now-solid caret; firing resetVisible's own
  // repaint too would write the frame twice. So snapshot repaintCount, run
  // dispatchKey, and repaint here ONLY when the caret was un-hidden AND
  // dispatchKey painted nothing (e.g. an unbound key) — otherwise the un-hide
  // rides the edit's frame for free.
  self.handleKeypress = (char, key) => {
    const caretUnhidden = self.pasting ? false : self.caretBlinkController.resetVisible();
    const repaintsBefore = self.repaintCount;
    InputDispatch.dispatchKey(self, char, key);
    if (caretUnhidden && self.repaintCount === repaintsBefore) self.repaint();
  };
  self.stdin.on('keypress', self.handleKeypress);

  // Invariant (arm ordering): set `armed = true` BEFORE registering the
  // ResizeBus subscribers below. The immediate channel fires synchronously
  // inside stdout's 'resize' event — if a SIGWINCH arrives between
  // `subscribeImmediate()` and `armed = true`, the handler's armed guard
  // would silently skip `resetGeometry()` and re-introduce the ghost-rows
  // bug this path exists to prevent (the debounced handler would still
  // call repaint() 150ms later, but against stale geometry). At this point
  // logUpdate, raw mode, bracketed-paste, and the keypress listener are
  // all wired — armed=true is consistent.
  self.armed = true;
  self.canceled = false;

  // External constraint (terminal resize semantics): SIGWINCH changes
  // `stdout.rows`, which changes the `targetBottomRow` passed to
  // CupFrameRenderer.render(). On the next repaint() the renderer reads the
  // current `stdout.rows` and positions the frame correctly — no separate
  // anchor step is needed (unlike log-update, which required an explicit
  // CUP before its first frame). The ResizeBus subscriber only needs to
  // trigger a repaint so the renderer recomputes the new bottom row.
  self.resizeUnsub = ResizeBus.subscribe(() => {
    // Defense-in-depth: skip if disarmed between SIGWINCH and the
    // 150ms-later debounced fire. `armed = true` is set above before
    // subscribe, so the arm-window race is closed; this guard only
    // protects the disarm-window race.
    if (!self.armed) return;
    self.repaint();
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
  self.resizeImmediateUnsub = ResizeBus.subscribeImmediate(() => {
    if (!self.armed) return;
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
    const newRows = self.stdout.rows ?? 24;
    if (self.lastKnownRows > 0 && newRows > self.lastKnownRows) {
      const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
      const frameTop = self.logUpdate?.topRow ?? 0;
      const bandTop = self.committedBand.length > 0 ? self.committedBandTopRow : 0;
      const tops = [frameTop, bandTop].filter((r) => r > 0);
      const top = tops.length > 0 ? Math.min(...tops) : 0;
      // The frame is always bottom-anchored at the OLD targetBottomRow.
      const bottom = Math.max(1, self.lastKnownRows - 1 - extraRows);
      if (top > 0 && top <= bottom) {
        self.pendingResizeErase = { top, bottom };
      }
    } else {
      // Net SHRINK or net-zero resize: any snapshot armed by a prior EXPAND
      // in this same pre-repaint window is now stale (see above) — drop it so
      // the clamped flush cannot wipe post-shrink reflowed/status rows.
      self.pendingResizeErase = null;
    }
    self.logUpdate?.resetGeometry?.();
    // NOTE: the committed band is intentionally NOT cleared here. Preserving
    // its content lets repositionCommittedBand() re-pin it directly above the
    // frame at the NEW geometry on the next repaint (it recomputes the band's
    // rows from the new frame top; the stale committedBandTopRow is only read
    // for a redundant vacated-gap erase, never a stale paint). The old
    // on-screen band copy is cleared via pendingResizeErase above on EXPAND,
    // or scrolled by the terminal on SHRINK.
    //
    // F2 (fail-safe commit mode on stale geometry): mark the band's row
    // geometry stale ALONGSIDE the logUpdate reset above — a commit that
    // lands in the window between this immediate handler and the next
    // debounced repaint (below) must not trust committedBandBottomRow as a
    // floor for prevTopRow (see the field doc on bandGeometryStale,
    // terminal-compositor.ts, and the prevTopRow site in
    // terminal-compositor.committed-band-commit.ts). Cleared by
    // repositionCommittedBand once it re-pins the band against real
    // post-resize geometry.
    self.bandGeometryStale = true;
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

  self.repaint();

  // Start the caret-blink ticker AFTER the first frame is painted so the
  // initial caret is solid. No-op when blinking is disabled or in capture mode.
  self.caretBlinkController.start();
}

export function disarm(self: LifecycleHost): void {
  self.spinnerController.dispose();
  // Stop the caret-blink ticker so no timer outlives the armed cycle (and no
  // stray tick fires repaint() against a disarmed compositor).
  self.caretBlinkController.stop();

  if (!self.armed) {
    // Still safe to clear state — no-op for listener/raw-mode.
    self.resetState();
    return;
  }

  if (self.handleKeypress) {
    self.stdin.removeListener('keypress', self.handleKeypress);
    self.handleKeypress = null;
  }
  if (self.resizeUnsub) {
    self.resizeUnsub();
    self.resizeUnsub = null;
  }
  if (self.resizeImmediateUnsub) {
    self.resizeImmediateUnsub();
    self.resizeImmediateUnsub = null;
  }

  // External constraint (band-hold materialization ordering): a block committed
  // under a full-viewport overlay is HELD in the committedBand model fully
  // pending — never painted to the terminal, never archived to scrollback —
  // until repositionCommittedBand materializes it when the overlay collapses
  // (committed-band-commit.ts newTopRow<=1 storage branch). If disarm() runs
  // FIRST (Ctrl-C / turn abort / mid-turn exit), logUpdate.clear() + resetState()
  // below discard that model, losing the block from screen AND history. So the
  // pending rows MUST be flushed to scrollback as real content BEFORE the clear
  // — the inverse-before-teardown rule. The painted suffix is already on screen
  // (repositionCommittedBand / Phase 3 painted it), so it is intentionally left
  // untouched; re-emitting it would duplicate it in scrollback (HARD CONSTRAINT
  // #1). Pending rows go to scrollback ONLY, never an on-screen truncated copy
  // (HARD CONSTRAINT #2).
  flushPendingCommittedBand(self);

  if (self.logUpdate) {
    try {
      self.logUpdate.clear(self.scrollRegion?.getExtraRows() ?? 0);
      // log-update hides the cursor on every render() when showCursor is
      // false (the default). Only done() calls cliCursor.show(); clear()
      // alone leaves the cursor hidden, leaking that state for the rest
      // of the session. Call done() after clear() to restore the cursor
      // before relinquishing control back to readline.
      self.logUpdate.done();
    } catch {
      /* noop */
    }
  }

  if (self.stdout.isTTY && self.stdin.isTTY) {
    // External constraint (drain ordering): disable bracketed-paste and
    // scroll-key BEFORE restoring raw mode. On rapid disarm/process-exit,
    // the writes can race against the kernel TTY flush — restoring raw mode
    // first can cause the disable sequences to be dropped, leaving the
    // terminal in bracketed-paste mode after the process exits (subsequent
    // shell commands see literal `\x1b[200~`/`\x1b[201~` around clipboard
    // pastes). Mirrors the single-drain ordering in raw-mode.ts.
    // \x1b[?1011l restores the terminal's scroll-key mode to its prior
    // state (see the enable in arm()).
    try {
      self.stdout.write('\x1b[?2004l\x1b[?1011l');
    } catch {
      /* stdout may have been closed */
    }
    try {
      self.stdin.setRawMode(self.wasRaw);
    } catch {
      /* noop */
    }
  }

  // Release the stdin claim before marking as unarmed so a subscriber
  // that checks isArmed() inside an acquire call sees the correct state.
  if (self.stdinClaim) {
    self.stdinClaim.release();
    self.stdinClaim = null;
  }

  self.armed = false;
  self.resetState();
  // Dispose the suggest engine AFTER resetState so no pending promise
  // resolves try to call repaint() on a disarmed compositor. The engine's
  // dispose() signals all in-flight promises to resolve null — the
  // buffer-identity guard in updateGhost's resolve handler will then
  // silently drop any result that arrives after this point.
  self.ghostEngine?.dispose();
}

/**
 * Stage 3 (#540 — single end-of-turn flush): commit the ENTIRE retained band
 * (painted rows + pending rows) to native scrollback as one contiguous write
 * at turn finalization, while geometry is stable (overlay cleared, spinner off).
 *
 * Unlike {@link flushPendingCommittedBand} (which only archives the in-model
 * prefix that was never painted), this function also handles the on-screen
 * PAINTED suffix — erasing it from the viewport (CUP+EL, no scroll, C1-safe)
 * before archiving the whole band, so the terminal's scrollback holds one
 * clean, complete, contiguous copy of all committed content from this turn.
 *
 * After the flush, `clearCommittedBand()` zeros the band state, making
 * `flushPendingCommittedBand` in `disarm()` a guaranteed no-op.
 *
 * Ordering: MUST be called before `disarm()` — disarm's `logUpdate.clear()`
 * will erase the live frame; endTurnFlush must run before that so the painted
 * band rows are explicitly archived (not silently erased) and `clearCommittedBand`
 * zeros the state before `flushPendingCommittedBand` checks it.
 *
 * C1 (scrollback is append-only) contract:
 *   • Painted rows are in the VIEWPORT, not scrollback — erasing them (CUP+EL)
 *     does NOT touch C1; the archive write is the first and only scrollback
 *     operation for these rows.
 *   • Pending rows were never painted — archive is their first and only write.
 *   • The archive uses `buildScrollbackArchiveEscape` (paint-at-floor + scroll),
 *     which is C1-safe by construction (same as Phase-1 and frame-preserve paths).
 *
 * No-op when: not armed, no logUpdate, or band is empty. Best-effort on
 * stdout write failure (terminal may have closed during teardown).
 */
export function endTurnFlush(self: LifecycleHost): void {
  if (!self.armed || !self.logUpdate || self.committedBand.length === 0) return;

  const rows = Math.max(1, self.stdout.rows ?? 24);
  const cols = Math.max(1, self.stdout.columns ?? 80);
  const anchorFloor = Math.max(self.anchorRow ?? 1, 1);
  const bandLen = self.committedBand.length;

  // Step 1: Erase the on-screen painted suffix (CUP+EL, NO \n — C1-safe).
  // The painted suffix occupies rows [paintedTop, committedBandBottomRow].
  // Only fired when there IS a painted suffix (paintedCount > 0 and a known
  // screen position). Without this, the archive below would write the same
  // content to scrollback while it is also on-screen, violating the
  // single-copy invariant on the NEXT turn's eviction pass — the on-screen
  // copy would scroll into scrollback AGAIN when the next commit's
  // preserveRowsBeforeFrameRender runs.
  const paintedCount = self.committedBandPaintedRows;
  if (paintedCount > 0 && self.committedBandBottomRow > 0) {
    const paintedTop = self.committedBandBottomRow - paintedCount + 1;
    let eraseOut = '\x1b[?25l';
    for (let r = Math.max(1, paintedTop); r <= self.committedBandBottomRow; r++) {
      eraseOut += eraseAndPaintRow(r); // CUP+EL, no line content, no \n
    }
    try {
      self.stdout.write(eraseOut);
    } catch {
      /* terminal closed mid-erase — carry on to archive so nothing is lost */
    }
  }

  // Step 2a: Clear the live frame BEFORE the archive scroll.
  // `buildScrollbackArchiveEscape` scrolls the entire viewport by the archive
  // height, which shifts any still-painted frame rows (prompt, overlay, input)
  // upward. The subsequent `disarm()` call's `logUpdate.clear()` erases at
  // pre-scroll coordinates — leaving the shifted frame rows as viewport ghosts.
  // Clearing first ensures the archive scroll operates against a blank slate.
  // Best-effort: a closed TTY or a throw here is non-fatal; the archive and
  // disarm will still clean up as much as possible.
  try {
    self.logUpdate.clear(self.scrollRegion?.getExtraRows() ?? 0);
  } catch {
    /* stdout closed or frame already cleared — carry on to archive */
  }

  // Step 2b: Archive the FULL band (all rows, painted + pending) to scrollback
  // as soft-wrappable logical lines via the shared archive path. `scrollbackFlushLines`
  // with count === bandLen emits the whole band; `buildScrollbackArchiveEscape`
  // paints it top-aligned at anchorFloor and scrolls it into scrollback.
  const allLines = scrollbackFlushLines(self.committedBand, self.committedBandMeta, bandLen);
  const archiveEscape = buildScrollbackArchiveEscape(allLines, anchorFloor, rows, cols);
  if (archiveEscape.length > 0) {
    const write = (): void => { self.stdout.write(archiveEscape); };
    try {
      if (self.scrollRegion) {
        self.scrollRegion.withFullScrollRegion(write);
      } else {
        write();
      }
    } catch {
      /* stdout closed mid-archive — disarm will clean up from here */
    }
  }

  // Step 3: Zero the band state. flushPendingCommittedBand in disarm() is now
  // a no-op (pendingCount = 0 - 0 = 0); repositionCommittedBand will not fire
  // (band empty); evict-on-growth in preserveRowsBeforeFrameRender will not
  // treat viewport rows as band content.
  self.clearCommittedBand();
}

/**
 * Flush the genuinely-unpainted prefix of the committed band to scrollback as
 * REAL content, so a disarm before repositionCommittedBand materializes a
 * band-hold model does not lose the committed block from screen AND history.
 *
 * Pending rows are the PREFIX `committedBand[0 .. length - committedBandPaintedRows)`
 * (every paint site materializes the BOTTOM suffix — see committedBandPaintedRows
 * on the class). When all rows are painted (the common teardown: overlay
 * collapsed → repositionCommittedBand painted everything → painted === length)
 * this is a no-op and the on-screen rows are left exactly as they are — never
 * re-emitted (HARD CONSTRAINT #1: no duplicate in scrollback).
 *
 * Mechanism (#540 axis-2 logical-line flush): the pending prefix is archived as
 * SOFT-WRAPPABLE logical lines, not pre-hard-wrapped physical rows, so a later
 * width resize reflows this scrolled-off content cleanly. scrollbackFlushLines
 * maps the `pendingCount` physical rows to logical lines — reading the FULL
 * band + meta (not just the prefix) so a logical line STRADDLING the
 * pending/painted boundary emits its pending rows verbatim rather than
 * duplicating the on-screen (painted) tail. buildScrollbackArchiveEscape writes
 * each line at the physical bottom margin with autowrap ON + a trailing `\n`,
 * so the TERMINAL owns the wrap and the `\n` scrolls it into history; the
 * terminal re-derives the same per-line physical-row count, so a pending run
 * taller than the terminal still archives every row (each line scrolls at the
 * bottom margin independently). Wrapped in `withFullScrollRegion` (no-op when no
 * status line is started) so the `\n` produces a FULL-screen scroll that enters
 * scrollback rather than a DECSTBM sub-region scroll that silently drops the
 * displaced top line. Best-effort: a throwing stdout means the process is
 * exiting anyway and the next teardown step tears us down.
 */
function flushPendingCommittedBand(self: LifecycleHost): void {
  const pendingCount = self.committedBand.length - self.committedBandPaintedRows;
  if (pendingCount <= 0) return;
  const rows = Math.max(1, self.stdout.rows ?? 24);
  const cols = Math.max(1, self.stdout.columns ?? 80);
  const anchorFloor = Math.max(self.anchorRow ?? 1, 1);
  const archiveLines = scrollbackFlushLines(self.committedBand, self.committedBandMeta, pendingCount);
  const escape = buildScrollbackArchiveEscape(archiveLines, anchorFloor, rows, cols);
  if (escape.length === 0) return;
  const write = (): void => {
    self.stdout.write(escape);
  };
  try {
    if (self.scrollRegion) {
      self.scrollRegion.withFullScrollRegion(write);
    } else {
      write();
    }
  } catch {
    /* stdout closed mid-flush (process exiting) — nothing more we can do */
  }
}
