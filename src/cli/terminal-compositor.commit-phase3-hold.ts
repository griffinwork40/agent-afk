import { hiddenArchivedRows } from './terminal-compositor.archived-reveal.js';
import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import type { CommitGeometry } from './terminal-compositor.commit-geometry.js';
import type { CommitRoute } from './terminal-compositor.commit-route.js';
import { eraseAndPaintRow } from './terminal-compositor.scrollback.js';
import { writeWithScrollGuard } from './terminal-compositor.commit-guard.js';
import { compositorBand } from './terminal-compositor.content-band.js';
import { retainedArchivedPrefix } from './terminal-compositor.band-archived-prefix.js';
import { stripAnsi } from './display.js';

/** Strip ANSI escapes then return the first visible character (or ''). */
function firstVisibleChar(raw: string): string {
  return stripAnsi(raw).trimStart()[0] ?? '';
}

/**
 * Band-hold Phase 3 for newTopRow > 1: track the committed run's RETAINED
 * suffix as the band model, but paint only the bottom paintedCount rows that
 * fit above the current frame. The rest are "pending" — in the model, not yet
 * on screen, not in scrollback. repositionCommittedBand paints the whole model
 * contiguously above the frame on the next shrink/collapse.
 *
 * #540: the retained suffix is overflowRun[archiveCount:], the exact
 * complement of what Phase 1 archived. archiveCount is capBandModel's
 * `overflowRun.length - maxBandModel` SNAPPED DOWN to a logical-line
 * boundary, so the model may retain up to (one logical line's height − 1)
 * rows BEYOND maxBandModel — a straddling logical line is kept whole here
 * rather than archived half now / half later (which re-fragments it). The
 * extra pending rows are painted on collapse / flushed on disarm like any
 * pending rows; the bound is one logical line, so the model never grows
 * unboundedly.
 */
export function commitPhase3Hold(
  self: CommittedBandHost,
  _geo: CommitGeometry,
  route: CommitRoute,
  newTopRow: number,
  maxRun: number,
): void {
  const { overflowRun, overflowRunMeta, archiveCount } = route;

  const model = overflowRun.slice(archiveCount);
  // #540: slice the provenance at the SAME index so it stays 1:1 with `model`.
  const modelMeta = overflowRunMeta.slice(archiveCount);
  const prefix = retainedArchivedPrefix(self, route.overflowPriorContiguous, archiveCount);
  const hidden = hiddenArchivedRows(self, undefined, { length: model.length, prefix });
  let paintedCount = Math.min(model.length - hidden, maxRun);
  // #4747: best-effort snap — avoid splitting a table's top border (┌) from
  // its content rows. Two cases:
  //
  // Case A — border is in the pending prefix above paintedCount:
  //   The tail-slice starts at model[model.length - paintedCount]. If that row
  //   starts with '│' and the row just above it starts with '┌', pull the
  //   border in (increment paintedCount) — only when maxRun allows it.
  //
  // Case B — border is the last row of the hidden archived prefix:
  //   model[hidden - 1] starts with '┌' and model[hidden] (first visible /
  //   first painted row) starts with '│'. Here paintedCount already equals
  //   model.length - hidden, so Case A's guard fails. Instead, increment
  //   paintedCount by 1 — this shifts the tail-slice start one row earlier
  //   (to model[model.length - paintedCount + i] with the new paintedCount),
  //   pulling the hidden border row into the painted window. `hidden` is not
  //   modified; it is only used to compute the initial paintedCount and is not
  //   referenced after this snap block — again only when maxRun allows.
  if (paintedCount > 0) {
    const firstPaintedIdx = model.length - paintedCount;
    if (
      firstVisibleChar(model[firstPaintedIdx] ?? '') === '│' &&
      firstVisibleChar(model[firstPaintedIdx - 1] ?? '') === '┌' &&
      paintedCount + 1 <= maxRun
    ) {
      // Case A: border is a pending (non-hidden) row just above the paint window.
      paintedCount += 1;
    } else if (
      hidden > 0 &&
      paintedCount === model.length - hidden &&
      firstVisibleChar(model[hidden] ?? '') === '│' &&
      firstVisibleChar(model[hidden - 1] ?? '') === '┌' &&
      paintedCount + 1 <= maxRun
    ) {
      // Case B: border is the last hidden archived-prefix row; increment
      // paintedCount to pull it into the tail-slice painted window.
      paintedCount += 1;
    }
  }
  const bandTop = newTopRow - paintedCount;
  // Content centering (AFK_CENTER_CONTENT): derive the margin from the CURRENT
  // terminal width so painted rows adapt on resize. The band stores raw (unpadded)
  // content; padding is applied at paint time only.
  const pad = compositorBand(self.stdout).margin;
  let out = '';
  for (let i = 0; i < paintedCount; i++) {
    const row = bandTop + i;
    if (row >= newTopRow) break; // Never overwrite the live frame.
    const raw = model[model.length - paintedCount + i];
    const line = pad && raw !== '' ? pad + raw : raw;
    out += eraseAndPaintRow(row, line);
  }
  if (out.length > 0) {
    writeWithScrollGuard(self, () => {
      self.stdout.write(out);
    });
  }
  self.committedBandArchivedPrefix = retainedArchivedPrefix(self, route.overflowPriorContiguous, archiveCount);
  self.committedBand = model;
  self.committedBandMeta = modelMeta;
  self.committedBandBottomRow = newTopRow - 1;
  self.committedBandTopRow = bandTop;
  // Only the bottom `paintedCount` rows reached the terminal; the rest of
  // the model is pending (painted by repositionCommittedBand on collapse).
  self.committedBandPaintedRows = paintedCount;
}

/**
 * Band-hold Phase 3 for newTopRow <= 1: full-viewport frame — no above-frame
 * row to paint now, but band-hold is active — the block fits the collapsed
 * screen. Store the model FULLY PENDING; repositionCommittedBand paints it on
 * the next shrink/collapse. committedBandBottomRow = collapsedFrameTop - 1
 * (NOT a 0 sentinel) lets a subsequent full-viewport commit satisfy
 * overflowPriorContiguous and MERGE.
 *
 * #540: the retained suffix is overflowRun[archiveCount:], the exact
 * complement of Phase 1's logical-boundary-snapped archive (same reasoning
 * as the newTopRow>1 band-hold arm above).
 */
export function commitPhase3HoldStore(
  self: CommittedBandHost,
  geo: CommitGeometry,
  route: CommitRoute,
): void {
  const { rows, extraRows, anchorFloor } = geo;
  const { overflowRun, overflowRunMeta, archiveCount } = route;

  const model = overflowRun.slice(archiveCount);
  const modelMeta = overflowRunMeta.slice(archiveCount);
  const collapsedFrameTop = Math.max(1, rows - 1 - extraRows);
  self.committedBandArchivedPrefix = retainedArchivedPrefix(self, route.overflowPriorContiguous, archiveCount);
  self.committedBand = model;
  self.committedBandMeta = modelMeta;
  self.committedBandBottomRow = Math.max(0, collapsedFrameTop - 1);
  self.committedBandTopRow = Math.max(anchorFloor, collapsedFrameTop - model.length);
  // Nothing was painted to the terminal: the whole model is PENDING until
  // repositionCommittedBand materializes it on collapse. If disarm() runs
  // first (Ctrl-C / abort / exit mid-turn), it flushes this pending model to
  // scrollback so the committed block is not lost from screen AND history.
  self.committedBandPaintedRows = 0;
}
