import type { InteractiveCtx } from './shared.js';
import { createVerdictLedger } from './verdict-ledger.js';
import { BackgroundStatusBar } from '../../background-status-bar.js';
import { LoopStageBar } from './loop-stage.js';
import { MascotBar } from './mascot-bar.js';
import { HealthRail } from '../../health-rail.js';
import { makeForegroundCountsGetter } from './foreground-counts.js';

/** Start footer painters in stacking order; coalesce later row-count changes. */
export function startFooterPainters(ctx: InteractiveCtx, verdictLedger: ReturnType<typeof createVerdictLedger>) {
  let bgBarRowCount = 0;
  let ledgerRowCount = 0;
  let mascotRowCount = 0;
  let healthRailRowCount = 0;
  const loopStageRows = 1; // LoopStageBar always occupies exactly 1 row.

  // Invariant: microtask-coalesced DECSTBM writes.
  //
  // Multiple tenants can fire onRowCountChange in the same synchronous
  // tick (e.g. a tool completes: mascot goes idle AND verdict-ledger
  // pushes a new entry).  Without coalescing, each tenant calls
  // syncExtraRows() which immediately emits a DECSTBM escape to the
  // terminal.  Two sequential DECSTBM writes in the same tick produce
  // two visible scroll-region adjustments, one of which is immediately
  // overwritten by the second — a wasted write at best, and at worst
  // a visible flicker if the terminal renders between the two.
  //
  // The coalescing gate defers the actual setExtraRows call and the
  // sibling-painter redraws to the next microtask.  All tenant count
  // updates within the same tick land in the same deferred flush, so
  // exactly one DECSTBM write and one round of sibling redraws fire.
  //
  // During startup (the start() sequence), coalescing is disabled so
  // each painter reads a fully-initialized getExtraRows() when it
  // first positions itself.
  let coalescing = false;
  let flushScheduled = false;
  const extraRowsSum = () =>
    healthRailRowCount + loopStageRows + mascotRowCount + bgBarRowCount + ledgerRowCount;

  const flushExtraRows = () => {
    flushScheduled = false;
    ctx.statusLine.setExtraRows(extraRowsSum());
    // Redraw all painters so they position against the freshly-updated
    // extraRows.  Each painter brackets its write in cursor save/restore,
    // so order is cosmetic; go bottom-to-top to match afterScrollRestore.
    bgStatusBar?.redraw();
    mascotBar?.redraw();
    loopStageBar?.redraw();
    healthRail?.redraw();
  };

  const syncExtraRows = () => {
    if (!coalescing) {
      ctx.statusLine.setExtraRows(extraRowsSum());
      return;
    }
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushExtraRows);
    }
  };

  // Hoisted so the verdict-ledger row-count handler (registered before the
  // bars are constructed) can reference them via closure. All are assigned
  // unconditionally below — the `?.` in the handler guards the window before
  // assignment (the handler only fires once a count actually changes).
  let bgStatusBar: BackgroundStatusBar | undefined;
  let loopStageBar: LoopStageBar | undefined;
  let mascotBar: MascotBar | undefined;
  let healthRail: HealthRail | undefined;

  // Register the verdict ledger row-count handler BEFORE constructing the bg
  // bar so its getAdjacentRows closure reads a consistent ledgerRowCount.
  // Invariant: each handler updates its local count synchronously, then
  // calls syncExtraRows().  In coalescing mode syncExtraRows schedules a
  // single deferred flush that emits ONE setExtraRows + ONE round of
  // sibling redraws for all count changes in the same tick.  During
  // startup (coalescing=false) the setExtraRows call is immediate.
  verdictLedger.setRowCountChangeHandler((rows) => {
    ledgerRowCount = rows;
    syncExtraRows();
  });

  bgStatusBar = new BackgroundStatusBar(ctx.backgroundRegistry, {
    // Rows that sit between the bg bar and the status line — i.e. the verdict
    // rail. Keeps bg-bar rows from overwriting the verdict row. (LoopStageBar
    // is ABOVE the bg bar, so it is not counted here.)
    getAdjacentRows: () => ledgerRowCount,
  });
  bgStatusBar.setRowCountChangeHandler((rows) => {
    bgBarRowCount = rows;
    syncExtraRows();
  });

  // Reacting goblin mini-sprite (issue #336) - opt-in via AFK_GOBLIN_MASCOT=1;
  // inert otherwise, in which case it reserves no rows and never paints, so the
  // sum above is unchanged for every operator who has not asked for it.
  mascotBar = new MascotBar({
    // Rows between the mascot band and the status line: the bg bar plus the
    // verdict rail. (LoopStageBar is ABOVE the mascot, so it is not counted.)
    getAdjacentRows: () => ledgerRowCount + bgBarRowCount,
  });
  mascotBar.setRowCountChangeHandler((rows) => {
    mascotRowCount = rows;
    syncExtraRows();
  });

  loopStageBar = new LoopStageBar({
    // LoopStageBar paints at totalRows - getExtraRows(), i.e. the topmost
    // reserved row, so it always sits above both the bg bar and the verdict
    // rail regardless of how their counts fluctuate. When the HealthRail is
    // active its 1 row is included in extraRows, so LoopStageBar automatically
    // shifts up by 1 and HealthRail paints directly above it.
    getExtraRows: () => ctx.statusLine.getExtraRows(),
  });
  loopStageBar.setRowCountChangeHandler((_rows) => {
    // LoopStageBar always occupies 1 row (loopStageRows, already in the sum).
    // Its start() fires this with 1 — establishing the base reservation — and
    // stop() with 0. Re-sync the combined total regardless of call order.
    syncExtraRows();
  });

  // Health rail — compact single-line session-vitals glance indicator.
  // Sits directly below the LoopStageBar within the reserved footer block.
  // Paint row: totalRows - getExtraRows() + 1
  // (LoopStageBar paints at totalRows - getExtraRows(), the topmost reserved row.)
  // healthRailRowCount is included in the extraRows sum so both bars shift
  // together when any lower bar changes its row count.
  healthRail = new HealthRail({
    backgroundRegistry: ctx.backgroundRegistry,
    getExtraRows: () => ctx.statusLine.getExtraRows(),
    getForegroundAgentCounts: makeForegroundCountsGetter(ctx.subagentManager, ctx.backgroundRegistry),
  });
  healthRail.setRowCountChangeHandler((rows) => {
    healthRailRowCount = rows;
    syncExtraRows();
  });

  // Footer self-heal after a full-screen scroll. commitAbove() and
  // evictRowsToScrollback() scroll the WHOLE screen (so displaced lines reach
  // the terminal's scrollback rather than a sub-region's void) via
  // StatusLine.withFullScrollRegion. That scroll drags the reserved footer rows
  // up with it. The status row re-flushes itself inside withFullScrollRegion,
  // but these painters only otherwise repaint on ResizeBus — so without this
  // hook their scrolled-up copies orphan above the status row (#634/#641).
  // Redraw all three so they self-heal exactly like the status line. Each
  // painter brackets its own write in save/restore, so order is cosmetic; we
  // go bottom → top (verdict rail, bg bar, loop-stage bar).
  ctx.statusLine.setAfterScrollRestore(() => {
    verdictLedger.repaint();
    bgStatusBar?.redraw();
    mascotBar?.redraw();
    loopStageBar?.redraw();
    healthRail?.redraw();
  });
  bgStatusBar.start();
  // Start the mascot before the loop-stage bar for the same reason the bg bar
  // goes first: LoopStageBar must read a fully-initialized extraRows. (The
  // mascot starts idle at 0 rows and claims on first working transition, so
  // this is ordering hygiene, not a fix.)
  mascotBar.start();
  // LoopStageBar must start AFTER bgStatusBar so it reads a fully-initialized
  // extraRows from StatusLine and paints at the correct row.  The bg bar may
  // start with 0 rows (no jobs yet), in which case the loop-stage bar sits
  // immediately above the status line.
  loopStageBar.start();
  // HealthRail starts AFTER LoopStageBar: its start() fires onRowCountChange(1),
  // which syncs extraRows and nudges LoopStageBar to shift up by 1 row. Starting
  // in this order ensures LoopStageBar is already registered and can respond to
  // the nudge. The health rail's initial repaint then lands at the correct row
  // (one above the just-shifted loop-stage bar).
  healthRail.start();

  // All painters are now initialized and have read their initial
  // getExtraRows().  Enable microtask coalescing for all subsequent
  // row-count changes so that multi-tenant events in the same tick
  // produce exactly one DECSTBM write + one round of sibling redraws.
  coalescing = true;

  // Start the verdict ledger painter. The verdict rail always occupies the
  // fixed slot immediately above the status line (row totalRows-1). The bg
  // bar floats above the verdict rail — it already accounts for the verdict
  // row via getAdjacentRows: () => ledgerRowCount above. The verdict painter
  // itself does NOT need getAdjacentRows because it is always at the bottom
  // of the reserved band, never displaced by anything below it.
  verdictLedger.start({ stream: process.stdout });

  return { bgStatusBar, loopStageBar, mascotBar, healthRail };
}
