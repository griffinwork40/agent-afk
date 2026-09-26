/**
 * Frame composition orchestrator — `repaint` (the per-frame render
 * orchestrator) and its picker-mode variant, extracted from
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
 *
 * Concern-based siblings:
 *   - `terminal-compositor.frame.layout.ts`   — viewport-budget computation
 *   - `terminal-compositor.frame.lines.ts`    — frame line assembly
 *   - `terminal-compositor.frame.position.ts` — physical row positioning
 *   - `terminal-compositor.frame-preserve.ts` — row preservation / scrollback eviction
 */

import type { SpinnerController } from './input/spinner.js';
import type {
  BandRowMeta,
  CompositorInputMode,
  CompositorScrollRegionGuard,
  FramePlacementMode,
  LogUpdateFn,
  PickerController,
} from './terminal-compositor.types.js';
import { preserveRowsBeforeFrameRender } from './terminal-compositor.frame-preserve.js';
import {
  reflowCommittedBandToWidth,
  type BandReflowCache,
} from './terminal-compositor.band-reflow.js';
import { type ImageAttachment } from './input/attachments.js';
import {
  gatherChromeRows,
  computeViewportLayout,
  computePickerViewportLayout,
} from './terminal-compositor.frame.layout.js';
import { buildFrameLines, buildPickerFrameLines } from './terminal-compositor.frame.lines.js';
import { computeFramePosition } from './terminal-compositor.frame.position.js';

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
  /** #540: per-physical-row logical provenance, index-aligned 1:1 with committedBand. */
  committedBandMeta: BandRowMeta[];
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
  /** Frame placement regime — see {@link FramePlacementMode}. */
  placementMode: FramePlacementMode;
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
  const clipboardRef = { value: self.clipboardFailureMsg };
  const chrome = gatherChromeRows(
    self.overlay,
    self.spinnerController,
    self.attachments,
    clipboardRef,
    self.stdout.columns ?? 80,
  );
  self.clipboardFailureMsg = clipboardRef.value;
  const dropdownRows = self.renderDropdownRows();
  const hintRow = self.renderHintRow();
  const layout = computeViewportLayout(
    chrome,
    dropdownRows.length,
    hintRow !== null,
    self.stdout.rows ?? 24,
    self.scrollRegion,
  );
  const frameLines = buildFrameLines(
    chrome,
    layout.trimmedOverlay,
    layout.renderGap,
    dropdownRows,
    hintRow,
    inputLine,
  );
  // Invariant: absoluteBottom is the maximum row the compositor may ever write
  // to — the row just above the bg-status-bar DECSTBM reservation. It is the
  // hard upper bound for targetBottomRow in ALL branches below.
  const absoluteBottom = Math.max(1, (self.stdout.rows ?? 24) - 1 - layout.extraRows);
  const frame = frameLines.join('\n');
  const { desiredTopRow, targetBottomRow } = computeFramePosition(
    frame,
    frameLines,
    absoluteBottom,
    self.placementMode,
    self.anchorRow,
    self.logUpdate,
  );
  // Record the real (unpadded) frame top for commitAbove's routing. This is the
  // value Phase-2 will re-establish; logUpdate.topRow (shrink-padded) is not.
  self.lastMeasuredFrameTop = desiredTopRow;
  preserveRowsBeforeFrameRender(self, desiredTopRow);
  // Capture the renderer's current top BEFORE render(): it is the first row
  // its erase pass will clear, which repositionCommittedBand() uses to detect
  // whether the render wiped the band (the collapse render, whose stale-tall
  // top erases down through it).
  const preRenderFrameTop = self.logUpdate.topRow ?? 0;
  // Invariant (cursor-follow erase reach): in cursor-follow mode the dropdown
  // can push targetBottomRow toward absoluteBottom, then closing the dropdown
  // snaps it back to anchorRow. The renderer's erase loop is clamped at the new
  // targetBottomRow by default, which would skip old dropdown rows sitting below
  // anchorRow — the "ghost autocomplete" artifact. When the new targetBottomRow
  // is less than the previous frame's bottom, override the erase ceiling so the
  // renderer clears the full old footprint. Cap at absoluteBottom to avoid
  // erasing footer-owned rows below the compositor's region.
  if (
    self.logUpdate.setEraseBottomOverride
    && self.logUpdate.topRow
    && self.logUpdate.topRow > 0
  ) {
    if (targetBottomRow < absoluteBottom) {
      self.logUpdate.setEraseBottomOverride(absoluteBottom);
    }
  }
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
  const clipboardRef = { value: self.clipboardFailureMsg };
  const chrome = gatherChromeRows(
    self.overlay,
    self.spinnerController,
    self.attachments,
    clipboardRef,
    self.stdout.columns ?? 80,
  );
  self.clipboardFailureMsg = clipboardRef.value;
  const layout = computePickerViewportLayout(
    chrome,
    pickerRows.length,
    self.stdout.rows ?? 24,
    self.scrollRegion,
  );
  const frameLines = buildPickerFrameLines(chrome, layout.trimmedOverlay, layout.renderGap, pickerRows);
  // Empty-frame guard: when the picker's renderRows() is empty and no
  // chrome is active, frameLines is []. The CupFrameRenderer clamps
  // rawLineCount to ≥1, so rendering an empty string would violate the
  // padded-covers-raw invariant added in PR #557 (lineCount=0 <
  // rawLineCount=1). Skip the render — nothing to draw on screen.
  if (frameLines.length === 0) return;
  const absoluteBottom = Math.max(1, (self.stdout.rows ?? 24) - 1 - layout.extraRows);
  const frame = frameLines.join('\n');
  // Wrap-aware top row — CupFrameRenderer hard-wraps at stdout.columns; sizing
  // the band off the logical line count re-pins it inside a soft-wrapped frame
  // (review #592). See repaint() for the full rationale.
  const desiredTopRow = self.logUpdate.measure
    ? self.logUpdate.measure(frame, absoluteBottom).topRow
    : Math.max(1, absoluteBottom - frameLines.length + 1);
  // Record the real (unpadded) frame top for commitAbove's routing, exactly as
  // the non-picker repaint() body does (see its `self.lastMeasuredFrameTop =
  // desiredTopRow;` above). Without this, a picker frame's row count differs
  // from whatever was on screen before the picker opened (a normal-mode
  // overlay+input frame vs. the picker's own rows), so lastMeasuredFrameTop
  // silently keeps describing the PRE-picker layout for as long as the picker
  // is active — a mismatch commitAbove's !bandGeometryStale gate cannot catch,
  // since it's not a resize. Any commitAbove() landing while the picker is up
  // (e.g. a backgrounded job's completion notice) would then trust a stale
  // measured top for a frame shape that no longer exists.
  self.lastMeasuredFrameTop = desiredTopRow;
  preserveRowsBeforeFrameRender(self, desiredTopRow);
  const preRenderFrameTop = self.logUpdate.topRow ?? 0;
  self.logUpdate.render(frame, absoluteBottom, self.anchorRow);
  self.repositionCommittedBand(desiredTopRow, preRenderFrameTop, absoluteBottom);
}
