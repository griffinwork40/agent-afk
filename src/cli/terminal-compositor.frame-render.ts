/**
 * Live-frame render + scrollback-eviction engine — `repaint` (the main
 * compositor repaint path), `preserveRowsBeforeFrameRender` (evict-on-growth
 * and anchor-row enforcement), `evictRowsToScrollback` (DECSTBM-region scroll
 * writes), and `repaintPickerFrame` (picker-mode variant of repaint) —
 * extracted from terminal-compositor.ts. Follows the free-functions-on-host
 * pattern used by the sibling committed-band/paste/autocomplete/render modules:
 * the TerminalCompositor owns all state; these functions read and MUTATE the
 * narrow {@link FrameRenderHost} slice it passes as `self`. No behavior
 * change — bodies are byte-for-byte moves with `this.` rewritten to `self.`
 * and intra-cluster calls made as direct module calls.
 *
 * The frame-render fields stay on the class (not lifted into a sub-object)
 * because the resize / scrollback test suite reaches into them directly; this
 * module only borrows them through the host interface.
 */

import { renderStatusLine } from './input/attachments.js';
import type { ImageAttachment } from './input/attachments.js';
import type { SpinnerController } from './input/spinner.js';
import { palette } from './palette.js';
import type { CompositorScrollRegionGuard, CompositorInputMode, LogUpdateFn, PickerController } from './terminal-compositor.types.js';

/**
 * Narrowest TerminalCompositor state slice the frame-render functions touch.
 * The frame-tracking fields, eviction state, and committed-band refs are
 * mutated in place; `logUpdate`/`stdout`/`scrollRegion` are collaborators;
 * and `flushResizeGhostErase`/`clearCommittedBand`/`repositionCommittedBand`/
 * `renderInputLine`/`renderDropdownRows`/`renderHintRow`/`debugLog` are class
 * methods the functions call back into.
 */
export interface FrameRenderHost {
  /** Whether the compositor currently holds raw mode + the keypress listener. */
  armed: boolean;
  /** The single log-update region tracker; null when not armed. */
  logUpdate: LogUpdateFn | null;
  /** Re-entrancy guard: suppresses a repaint during the clear→write window. */
  committing: boolean;
  /** True while suspendInput() is in effect — suppresses spinner/overlay repaints. */
  suspended: boolean;
  /** The last row count observed at repaint time (for resize expand/shrink detection). */
  lastKnownRows: number;
  /** Current input mode — normal, idle, or picker. */
  inputMode: CompositorInputMode;
  /** Active picker controller — non-null IFF inputMode === 'picker'. */
  pickerController: PickerController | null;
  /** Current overlay content (live streaming markdown). */
  overlay: string;
  /** Spinner/tip renderer. */
  readonly spinnerController: SpinnerController;
  readonly stdout: NodeJS.WriteStream;
  /** Image attachments accumulated via bracketed paste / Ctrl+V. */
  attachments: ImageAttachment[];
  /** Paint-clear status line surfaced when a clipboard probe found no image. */
  clipboardFailureMsg: string | null;
  /** DECSTBM scroll-region guard; absent when no status line is active. */
  readonly scrollRegion?: CompositorScrollRegionGuard;
  /** Pre-arm content ceiling — committed text never lands above this row. */
  anchorRow: number | undefined;
  /** Whether any commit has happened this arm cycle (guards growthDeficit). */
  hasCommitted: boolean;
  /** The full contiguous on-screen committed run adjacent to the frame top. */
  committedBand: string[];
  committedBandTopRow: number;
  committedBandBottomRow: number;
  /** Pre-resize on-screen footprint to physically erase on the next repaint. */
  pendingResizeErase: { top: number; bottom: number } | null;

  /** Physically erase the pre-resize on-screen footprint (SIGWINCH handler). */
  flushResizeGhostErase(): void;
  /** Clear committed-band tracking state. */
  clearCommittedBand(): void;
  /** Re-pin the committed band above the live frame after a repaint. */
  repositionCommittedBand(desiredTopRow: number, preRenderFrameTop: number, targetBottomRow: number): void;
  /** Render the input line for the current frame. */
  renderInputLine(): string;
  /** Render autocomplete dropdown rows for the current frame. */
  renderDropdownRows(): string[];
  /** Render the selected-candidate hint row (or null when dropdown is closed). */
  renderHintRow(): string | null;
  /** Structured debug tracer (no-op unless compositor debugging is enabled). */
  debugLog(stage: string, extra?: Record<string, unknown>): void;
}

/** @internal Public for sibling free-function modules (via Host interfaces) and test casts. */
export function repaint(self: FrameRenderHost): void {
  // Invariant: when suspended for an external readline (elicitation
  // `rl.question`, arrow-key selector), the compositor MUST NOT repaint —
  // the spinner ticker (80ms `setInterval`) and any out-of-band setOverlay
  // callers will otherwise clobber the user's prompt and typed characters.
  // Restored by `resumeInput()` which itself calls `repaint()` once.
  if (!self.armed || !self.logUpdate || self.committing || self.suspended) return;
  // Resize ghost-erase: physically clear the pre-resize on-screen footprint
  // captured by the SIGWINCH immediate handler BEFORE painting the new
  // geometry, so an expand does not leave the old frame/band frozen as
  // ghosts. Placed above the picker short-circuit so both normal and picker
  // repaints flush it. Recording lastKnownRows here (every repaint, both
  // paths) gives the resize handler the pre-resize row count to detect
  // expand vs shrink.
  self.flushResizeGhostErase();
  self.lastKnownRows = self.stdout.rows ?? 24;
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
  if (self.inputMode === 'picker' && self.pickerController) {
    repaintPickerFrame(self);
    return;
  }
  const inputLine = self.renderInputLine();
  const overlayLines = self.overlay ? self.overlay.split('\n') : [];
  const spinnerRow = self.spinnerController.renderSpinnerRow();
  // Tip row sits BELOW the spinner row, ABOVE the input line. Renders only
  // when the spinner has a tip — `selectTip` enforces the warmup grace, so
  // sub-second turns never paint a tip and then tear it down.
  const tipRow = self.spinnerController.renderTipRow(self.stdout.columns ?? 80);
  // Attachment status row — listed pasted/clipboard images so the user
  // can see what's about to ride along on the next submission. Mutually
  // exclusive with the clipboard-failure row (an ephemeral notice that
  // last clipboard probe found no image — paint-clear: consumed on
  // this repaint so the message disappears as soon as the user acts).
  let attachmentRow: string | null = null;
  if (self.attachments.length > 0) {
    attachmentRow = renderStatusLine(self.attachments);
  } else if (self.clipboardFailureMsg !== null) {
    attachmentRow = palette.dim(self.clipboardFailureMsg);
    self.clipboardFailureMsg = null;
  }
  const dropdownRows = self.renderDropdownRows();
  const hintRow = self.renderHintRow();
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
  const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
  const maxLines = Math.max(1, (self.stdout.rows ?? 24) - 1 - extraRows);
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
  const targetBottomRow = Math.max(1, (self.stdout.rows ?? 24) - 1 - extraRows);
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
  const desiredTopRow = self.logUpdate.measure
    ? self.logUpdate.measure(frame, targetBottomRow).topRow
    : Math.max(1, targetBottomRow - frameLines.length + 1);
  preserveRowsBeforeFrameRender(self, desiredTopRow);
  // Capture the renderer's current top BEFORE render(): it is the first row
  // its erase pass will clear, which repositionCommittedBand() uses to detect
  // whether the render wiped the band (the collapse render, whose stale-tall
  // top erases down through it).
  const preRenderFrameTop = self.logUpdate.topRow ?? 0;
  self.logUpdate.render(frame, targetBottomRow);
  self.repositionCommittedBand(desiredTopRow, preRenderFrameTop, targetBottomRow);
}

/**
 * Preserve rows that the next compositor frame is about to cover.
 *
 * Shared by normal input repaints and picker repaints: both ultimately use
 * the same log-update renderer, and both can grow upward into the single
 * above-frame copy written by `commitAbove()`. Keeping the eviction in one
 * pre-render path prevents picker mode from bypassing commit durability.
 */
function preserveRowsBeforeFrameRender(self: FrameRenderHost, desiredTopRow: number): void {
  // Evict-on-growth (durability for single-copy commits): when the frame
  // grows upward — its top climbs above the previously-rendered frame top —
  // the rows it is about to CUP-paint over hold committed transcript content
  // (commitAbove's above-frame band). Get that content into terminal
  // scrollback BEFORE the frame render overwrites it.
  const prevTopRow = self.logUpdate?.topRow ?? 0;
  const hasBanner = self.anchorRow !== undefined && self.anchorRow > 1;

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
    const grew = self.hasCommitted && prevTopRow > 1 && desiredTopRow < prevTopRow;
    const bandLen = self.committedBand.length;
    if (!grew || bandLen === 0) return;
    const room = Math.max(0, desiredTopRow - 1);
    const overflow = bandLen - room;
    if (overflow <= 0) return; // whole band fits above the new frame — no scroll
    // Re-paint the full band top-aligned at [1, bandLen], erasing its old
    // floating position, so the scroll carries the oldest `overflow` lines —
    // real content, never blank rows — into scrollback. The frame render that
    // follows repaints its own (lower) footprint; survivors sit above it.
    let out = '';
    for (let r = Math.max(1, self.committedBandTopRow); r <= self.committedBandBottomRow; r++) {
      out += `\x1b[${r};1H\x1b[2K`;
    }
    for (let i = 0; i < bandLen; i++) {
      out += `\x1b[${1 + i};1H\x1b[2K${self.committedBand[i] ?? ''}`;
    }
    try {
      self.stdout.write(out);
    } catch {
      /* terminal closed mid-render — next render's lifecycle tears us down */
    }
    evictRowsToScrollback(self, overflow);
    // Survivors physically shifted to [1, room] by the scroll — already
    // hugging the new frame top (room === desiredTopRow - 1). Record that so a
    // later shrink re-pins from the right place.
    self.committedBand = self.committedBand.slice(overflow);
    self.committedBandTopRow = 1;
    self.committedBandBottomRow = room;
    return;
  }

  // Banner present (anchorRow > 1): legacy deficit-based eviction, unchanged.
  const growthDeficit = (self.hasCommitted && prevTopRow > 1) ? Math.max(0, prevTopRow - desiredTopRow) : 0;
  // Anchor-row enforcement (legacy ceiling): never let the frame top climb
  // above a supplied pre-arm ceiling (welcome banner / update notice)
  // without first preserving the rows down to it.
  const anchorDeficit =
    desiredTopRow < self.anchorRow! ? self.anchorRow! - desiredTopRow : 0;
  const deficit = Math.max(growthDeficit, anchorDeficit);
  if (deficit > 0) {
    evictRowsToScrollback(self, deficit);
    // Everything (including pre-arm content) scrolled up by `deficit`, so the
    // safe ceiling moves up the same amount. Clamp at 1; once the banner has
    // fully scrolled into scrollback there is nothing left to protect.
    if (self.anchorRow !== undefined && self.anchorRow > 1) {
      self.anchorRow = Math.max(1, self.anchorRow - deficit);
    }
    // The committed band scrolled up by the same `deficit` (a small growth —
    // e.g. the spinner appearing — does NOT push it off-screen; it stays in
    // the viewport, one row higher). Shift its tracked rows so a later shrink
    // re-pins at the right screen position. Drop only the lines that crossed
    // ABOVE the anchor floor into terminal scrollback, so the re-pin never
    // paints scrolled-away content back into the viewport (which would
    // duplicate what the terminal already holds in scrollback).
    if (self.committedBand.length > 0) {
      self.committedBandTopRow -= deficit;
      self.committedBandBottomRow -= deficit;
      const floor = Math.max(self.anchorRow ?? 1, 1);
      if (self.committedBandTopRow < floor) {
        const lost = floor - self.committedBandTopRow;
        self.committedBand = self.committedBand.slice(lost);
        self.committedBandTopRow = floor;
      }
      if (self.committedBand.length === 0 || self.committedBandBottomRow < floor) {
        self.clearCommittedBand();
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
function evictRowsToScrollback(self: FrameRenderHost, rows: number): void {
  if (rows <= 0) return;
  self.debugLog('evict:enter', { rows, anchorRow: self.anchorRow ?? null });
  // Invariant (DECSTBM scroll trigger): a `\n` scrolls the region only when
  // the cursor sits AT the bottom margin. Under withFullScrollRegion (and the
  // no-scrollRegion default) that margin is the physical last row
  // (self.stdout.rows). CUP there — NOT to targetBottomRow (rows-1-extraRows),
  // which sits one-or-more rows ABOVE the margin, so the first `\n`(s) would
  // merely move the cursor down without scrolling, yielding fewer than `rows`
  // scrolls and letting the growing frame overwrite the committed content
  // this eviction exists to preserve (review #592 BLOCKER-2). Safe even with a
  // status line: withFullScrollRegion forces the full-screen region and
  // repaints the status row afterward.
  const physicalBottom = Math.max(1, self.stdout.rows ?? 24);
  const escape = `\x1b[${physicalBottom};1H${'\n'.repeat(rows)}`;
  const doWrite = (): void => {
    try {
      self.stdout.write(escape);
    } catch (err) {
      self.debugLog('evict:error', { msg: (err as Error)?.message ?? String(err) });
      // Stdout may be closed mid-render (process exit, terminal hangup);
      // the next render() call will fail too and the surface lifecycle
      // will tear us down — nothing more we can do here.
    }
  };
  if (self.scrollRegion !== undefined) {
    self.scrollRegion.withFullScrollRegion(doWrite);
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
function repaintPickerFrame(self: FrameRenderHost): void {
  if (!self.logUpdate || !self.pickerController) return;
  const pickerRows = [...self.pickerController.renderRows()];
  const overlayLines = self.overlay ? self.overlay.split('\n') : [];
  const spinnerRow = self.spinnerController.renderSpinnerRow();
  const tipRow = self.spinnerController.renderTipRow(self.stdout.columns ?? 80);
  let attachmentRow: string | null = null;
  if (self.attachments.length > 0) {
    attachmentRow = renderStatusLine(self.attachments);
  } else if (self.clipboardFailureMsg !== null) {
    attachmentRow = palette.dim(self.clipboardFailureMsg);
    self.clipboardFailureMsg = null;
  }
  const hasFixedChrome = !!spinnerRow || !!tipRow || !!attachmentRow;
  const hasContentAboveInput = hasFixedChrome || overlayLines.length > 0;
  // Invariant: the bg status bar (when active) owns rows (rows-extraRows)..(rows-1).
  // Compositor frame must stay above that region or the two writers race the same physical row
  // every spinner tick, producing flicker. Mirrors DECSTBM math in status-line.ts:287.
  const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
  const maxLines = Math.max(1, (self.stdout.rows ?? 24) - 1 - extraRows);
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
  const targetBottomRow = Math.max(1, (self.stdout.rows ?? 24) - 1 - extraRows);
  const frame = frameLines.join('\n');
  // Wrap-aware top row — CupFrameRenderer hard-wraps at stdout.columns; sizing
  // the band off the logical line count re-pins it inside a soft-wrapped frame
  // (review #592). See repaint() for the full rationale.
  const desiredTopRow = self.logUpdate.measure
    ? self.logUpdate.measure(frame, targetBottomRow).topRow
    : Math.max(1, targetBottomRow - frameLines.length + 1);
  preserveRowsBeforeFrameRender(self, desiredTopRow);
  const preRenderFrameTop = self.logUpdate.topRow ?? 0;
  self.logUpdate.render(frame, targetBottomRow);
  self.repositionCommittedBand(desiredTopRow, preRenderFrameTop, targetBottomRow);
}
