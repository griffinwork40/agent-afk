/**
 * Frame composition + scrollback eviction — `repaint` (the per-frame render
 * orchestrator), its picker-mode variant, and the pre-render
 * row-preservation / scrollback-eviction primitives — extracted from
 * terminal-compositor.ts. Follows the free-functions-on-host pattern used by
 * the sibling render/committed-band/input-dispatch modules: the
 * TerminalCompositor owns all state; these functions read and MUTATE the narrow
 * {@link FrameHost} slice it passes as `self`, and collaborate with the
 * render / committed-band slices through the same Host methods the class
 * already exposes (`renderInputLine`, `repositionCommittedBand`, …) — the
 * established convention for cross-module calls (mirrors committed-band.ts
 * calling `self.repaint()`). No behavior change — bodies are byte-for-byte
 * moves with `this.` rewritten to `self.`.
 *
 * `repaint` is the only export: the class keeps a thin `repaint()` delegator
 * that 7 test files cast-invoke and the spinner ticker drives. The other three
 * functions (`repaintPickerFrame`, `preserveRowsBeforeFrameRender`,
 * `evictRowsToScrollback`) are module-private — they had no callers outside
 * this cluster.
 */

import { palette } from './palette.js';
import { renderStatusLine, type ImageAttachment } from './input/attachments.js';
import type { SpinnerController } from './input/spinner.js';
import type {
  CompositorInputMode,
  CompositorScrollRegionGuard,
  LogUpdateFn,
  PickerController,
} from './terminal-compositor.types.js';
import { preserveRowsBeforeFrameRender } from './terminal-compositor.frame-preserve.js';
import {
  reflowCommittedBandToWidth,
  type BandReflowCache,
} from './terminal-compositor.band-reflow.js';

/**
 * Narrowest TerminalCompositor state slice the frame-composition functions
 * touch. Render/committed-band collaboration goes through the class delegators
 * declared here as methods (`renderInputLine`, `flushResizeGhostErase`,
 * `repositionCommittedBand`, `clearCommittedBand`); the band-tracking fields,
 * `anchorRow`, `clipboardFailureMsg`, and `lastKnownRows` are mutated in place;
 * the rest are read-only frame-content sources.
 */
export interface FrameHost {
  // ── render + committed-band collaborators (class delegators) ──
  flushResizeGhostErase(): void;
  renderInputLine(): string;
  renderDropdownRows(): string[];
  renderHintRow(): string | null;
  repositionCommittedBand(
    desiredTopRow: number,
    preRenderFrameTop: number,
    targetBottomRow: number,
  ): void;
  clearCommittedBand(): void;
  /** Structured debug tracer (no-op unless compositor debugging is enabled). */
  debugLog(stage: string, extra?: Record<string, unknown>): void;
  // ── lifecycle / guard state ──
  armed: boolean;
  committing: boolean;
  suspended: boolean;
  logUpdate: LogUpdateFn | null;
  // ── frame-content sources ──
  overlay: string;
  inputMode: CompositorInputMode;
  pickerController: PickerController | null;
  readonly spinnerController: SpinnerController;
  attachments: ImageAttachment[];
  clipboardFailureMsg: string | null;
  // ── committed-band tracking (mutated by preserveRowsBeforeFrameRender) ──
  committedBand: string[];
  committedBandTopRow: number;
  committedBandBottomRow: number;
  /** Real unpadded frame top; written here by repaint(), read by commitAbove's
   *  routing. See the field doc on the class (terminal-compositor.ts). */
  lastMeasuredFrameTop: number;
  committedBandPaintedRows: number;
  /** Memoization for reflowCommittedBandToWidth — see the field doc on the class. */
  bandReflowCache: BandReflowCache | null;
  hasCommitted: boolean;
  anchorRow: number | undefined;
  lastKnownRows: number;
  /** True while commitAbove is executing (Phase 1 → Phase 3). Guards Phase 2
   *  repaints from applying content-following, which would misplace the frame
   *  and cause Phase 3 to write into the banner zone. */
  commitInFlight: boolean;
  // ── collaborators ──
  readonly scrollRegion?: CompositorScrollRegionGuard;
  readonly stdout: NodeJS.WriteStream;
}

export function repaint(self: FrameHost): void {
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
  // F1 (retained-logical-source re-wrap): re-wrap the retained band at the
  // CURRENT width before EITHER downstream consumer reads it this repaint —
  // preserveRowsBeforeFrameRender's eviction paints (called below and from
  // repaintPickerFrame) and repositionCommittedBand's re-pin (same two call
  // sites) both read `self.committedBand` verbatim. Placed above the picker
  // short-circuit so both paths see fresh-width rows; a steady-width repeat
  // repaint is a cache hit (see reflowCommittedBandToWidth) and costs nothing.
  reflowCommittedBandToWidth(self, self.stdout.columns ?? 80);
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
  // Invariant: absoluteBottom is the maximum row the compositor may ever write
  // to — the row just above the bg-status-bar DECSTBM reservation. It is the
  // hard upper bound for targetBottomRow in ALL branches below.
  const absoluteBottom = Math.max(1, (self.stdout.rows ?? 24) - 1 - extraRows);
  const frame = frameLines.join('\n');
  // Invariant: the input frame is ALWAYS bottom-pinned (targetBottomRow ===
  // absoluteBottom), on a fresh session and after every commit alike. The
  // input line is the last frameLines entry, so it sits on absoluteBottom; the
  // dropdown / hint / streaming overlay grow UPWARD into the empty viewport
  // above it ("input pinned, content rises") without ever shifting the row the
  // user types on. This is what makes opening the slash-command menu on a
  // brand-new session leave the prompt put instead of shoving it down to make
  // headroom.
  //
  // History: this used to be a two-regime placement — "content-following"
  // (frame pinned just below the banner at min(absoluteBottom,
  // max(anchorRow, committedBandBottomRow) + physicalRows)) while idle with a
  // banner, bottom-anchored only during a commit or once enough committed
  // content had marched the frame to the floor. The side effect was that on a
  // fresh session the prompt sat one row under the banner with no room above
  // it, so opening the completion dropdown grew physicalRows and pushed the
  // whole frame DOWN. Unconditional bottom-pinning removes that regime; the
  // banner is still protected as a ceiling by the anchorRow floor in
  // frame-preserve.ts / committed-band-repin.ts, and committed text still lands
  // in the above-frame region — it just accumulates upward from the bottom
  // (newest hugging the input) instead of downward from the banner.
  const targetBottomRow = absoluteBottom;
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
  // Record the real (unpadded) frame top for commitAbove's routing. This is the
  // value Phase-2 will re-establish; logUpdate.topRow (shrink-padded) is not.
  self.lastMeasuredFrameTop = desiredTopRow;
  preserveRowsBeforeFrameRender(self, desiredTopRow);
  // Capture the renderer's current top BEFORE render(): it is the first row
  // its erase pass will clear, which repositionCommittedBand() uses to detect
  // whether the render wiped the band (the collapse render, whose stale-tall
  // top erases down through it).
  const preRenderFrameTop = self.logUpdate.topRow ?? 0;
  self.logUpdate.render(frame, targetBottomRow, self.anchorRow);
  self.repositionCommittedBand(desiredTopRow, preRenderFrameTop, targetBottomRow);
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
function repaintPickerFrame(self: FrameHost): void {
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
  self.logUpdate.render(frame, targetBottomRow, self.anchorRow);
  self.repositionCommittedBand(desiredTopRow, preRenderFrameTop, targetBottomRow);
}
