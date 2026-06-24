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
  CompositorScrollRegionGuard,
  KeyInfo,
  LogUpdateFn,
} from './terminal-compositor.types.js';
import { eraseAndPaintRow } from './terminal-compositor.types.js';
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
  readonly committedBandTopRow: number;
  // Read by disarm() to flush genuinely-unpainted committed-band rows to
  // scrollback before teardown. See committedBandPaintedRows on the class.
  readonly committedBandPaintedRows: number;
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
    self.stdout.write('\x1b[?2004h');
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
  self.handleKeypress = (char, key) => {
    if (!self.pasting) self.caretBlinkController.resetVisible();
    InputDispatch.dispatchKey(self, char, key);
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
    // External constraint (drain ordering): disable bracketed-paste BEFORE
    // restoring raw mode. On rapid disarm/process-exit, the two writes
    // can race against the kernel TTY flush — restoring raw mode first
    // can cause the disable sequence to be dropped, leaving the terminal
    // in bracketed-paste mode after the process exits (subsequent shell
    // commands see literal `\x1b[200~`/`\x1b[201~` around clipboard
    // pastes). Mirrors the single-drain ordering in raw-mode.ts.
    try {
      self.stdout.write('\x1b[?2004l');
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
 * Mechanism: the proven top-write-then-scroll the band-hold Phase-1 archive
 * uses (committed-band-commit.ts) — CUP+EL each pending row at the anchor floor,
 * then a CUP to the physical bottom + `\n`×count to scroll them into history.
 * Chunked by screen height so a pending run taller than the terminal still
 * archives every row. Wrapped in `withFullScrollRegion` (no-op when no status
 * line is started) so the `\n` produces a FULL-screen scroll that enters
 * scrollback rather than a DECSTBM sub-region scroll that silently drops the
 * displaced top line. Best-effort: a throwing stdout means the process is
 * exiting anyway and the next teardown step tears us down.
 */
function flushPendingCommittedBand(self: LifecycleHost): void {
  const pendingCount = self.committedBand.length - self.committedBandPaintedRows;
  if (pendingCount <= 0) return;
  const pending = self.committedBand.slice(0, pendingCount);
  const rows = Math.max(1, self.stdout.rows ?? 24);
  const anchorFloor = Math.max(self.anchorRow ?? 1, 1);
  const write = (): void => {
    const chunkMax = Math.max(1, rows - anchorFloor + 1);
    for (let start = 0; start < pending.length; start += chunkMax) {
      const chunk = pending.slice(start, Math.min(start + chunkMax, pending.length));
      const topWrite = chunk
        .map((l, i) => eraseAndPaintRow(anchorFloor + i, l))
        .join('');
      self.stdout.write(`${topWrite}\x1b[${rows};1H${'\n'.repeat(chunk.length)}`);
    }
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
