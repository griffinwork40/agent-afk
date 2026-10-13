/**
 * Live overlay rendering for {@link ToolLane}.
 *
 * Extracted from `tool-lane.ts` so the overlay concern lives in a dedicated
 * module while the class retains a thin delegating method. The public surface
 * is {@link renderToolLaneOverlay}, which accepts the lane's data as plain
 * parameters and returns the fully composed overlay string.
 *
 * Root-entry rendering helpers (renderNestingWithChildren, renderNestingChildless,
 * renderFlatRoot) live in `tool-lane-overlay-roots.ts` (extracted for the
 * 200-line function ceiling, issue #3478).
 */

import { palette } from '../../palette.js';
import { NESTING_TOOLS } from '../../tool-category.js';
import { truncateDisplayWidth } from '../../display.js';
import {
  buildChildMap,
  getGlyphs,
  toolLaneWidth,
  joinOverlayLines,
  type ToolEntry,
  type Entry,
} from './tool-lane-render.js';
import {
  renderNestingWithChildren,
  renderNestingChildless,
  renderFlatRoot,
} from './tool-lane-overlay-roots.js';
import type { ToolLaneFlash } from './tool-lane-flash.js';
import type { ElementFade } from '../../smoke-fade.js';

/**
 * Collect root-level tool entries (those rendered at the top of the overlay),
 * then apply the `maxOverlayRoots` sliding-window cap. The cap protects long
 * multi-tool turns from filling the screen with completed rows. Active
 * (no-result) roots are *always* kept so the user can see what is currently
 * running — only the oldest *completed* roots are elided, summarized by the
 * caller via a trailing "… +N done" line.
 */
export function selectVisibleRoots(
  entries: Map<string, Entry>,
  order: string[],
  maxOverlayRoots: number,
): { visibleRoots: ToolEntry[]; hiddenDoneCount: number } {
  const rootEntries: ToolEntry[] = [];
  for (const id of order) {
    const entry = entries.get(id);
    if (!entry || entry.kind !== 'tool' || entry.agentContext) continue;
    rootEntries.push(entry);
  }
  if (rootEntries.length <= maxOverlayRoots) return { visibleRoots: rootEntries, hiddenDoneCount: 0 };
  // Identify active (in-progress) roots — they bypass the cap.
  const activeRoots = rootEntries.filter((e) => !e.result);
  const doneRoots = rootEntries.filter((e) => e.result);
  // Reserve all active slots; fill remaining slots from the *tail* of
  // doneRoots (most recently completed), preserving original order.
  const doneBudget = Math.max(0, maxOverlayRoots - activeRoots.length);
  const visibleDoneSet = new Set(doneRoots.slice(-doneBudget));
  return {
    visibleRoots: rootEntries.filter((e) => !e.result || visibleDoneSet.has(e)),
    hiddenDoneCount: doneRoots.length - visibleDoneSet.size,
  };
}

/**
 * Render the live tool-lane overlay string.
 *
 * Pure function: all lane state is passed as parameters so the function is
 * testable in isolation and the `ToolLane` class remains the single owner of
 * state. The overlay is rebuilt from scratch on every frame (callers drive
 * repaint timing).
 *
 * Root-entry branches delegate to named helpers in `tool-lane-overlay-roots.ts`:
 *   - {@link renderNestingWithChildren} — NESTING root with in-lane children
 *   - {@link renderNestingChildless}    — NESTING root with no in-lane children
 *   - {@link renderFlatRoot}            — non-NESTING (flat leaf) root
 *
 * @param entries         Live entry map (keyed by `toolUseId`).
 * @param order           Insertion-ordered list of `toolUseId` keys.
 * @param activeTools     Current parallel-activity snapshot, or `null`.
 * @param flash           Optional flash tracker for 150ms glyph pulses.
 * @param maxOverlayRoots Maximum number of root-level entries to show.
 * @param fade            Optional AFK_SMOKE_TEXT whole-element fade. Each root
 *                        entry's rows (its line, children, tails, diff) fade
 *                        in together, keyed by `toolUseId`, on the frame that
 *                        first shows them. Settled rows render unchanged.
 */
export function renderToolLaneOverlay(
  entries: Map<string, Entry>,
  order: string[],
  activeTools: { activeCount: number; toolUseIds: Set<string>; toolIndex?: Map<string, number> } | null,
  flash: ToolLaneFlash | null,
  maxOverlayRoots: number,
  fade: ElementFade | null = null,
): string {
  const childMap = buildChildMap(entries, order);
  const lines: string[] = [];
  // Read glyphs once per overlay frame so the turn-root marker on Agent
  // rows matches the spine glyphs renderOverlayChildren will draw below.
  // (Both functions default to getGlyphs() but reading once here makes the
  // dependency explicit and shares one value across the loop.)
  const g = getGlyphs();
  // Width invariant for every root-entry line pushed below: terminal soft-wrap
  // strips the leading indent on continuation rows, which orphans flush-left
  // text between siblings and breaks the topology spine drawn by
  // renderOverlayChildren. Clamp every composed line to `cols` so the
  // terminal never has to wrap. Mirrors the clamp inside
  // `renderOverlayChildren` / `renderFlushChildren` in tool-lane-render.ts.
  // Read once per frame — `getTerminalWidth()` is a process.stdout.columns
  // lookup, but consistency across the frame matters more than a few µs.
  const cols = toolLaneWidth();

  const { visibleRoots, hiddenDoneCount } = selectVisibleRoots(entries, order, maxOverlayRoots);

  // Invariant: when the overlay mixes a NESTING root (skill / Agent / compose
  // — each anchors a col-0 ◉ turn-root marker and a descendant spine drawn at
  // col 0 by renderOverlayChildren) with flat-leaf roots, the flat roots must
  // ALSO anchor their own col-0 ◉. A flat leaf's bare 3-space lead places its
  // `●` glyph at col 3 (the NESTING block's depth-1 connector column) with a
  // BLANK col 0 — so a main-session read_file dispatched after a subagent
  // renders directly below a `│` spine with nothing in col 0, reading as a
  // severed / orphaned node that "fell out" of the subagent tree. Anchoring
  // col 0 with ◉ turns the `│ → ◉` transition into an honest "spine ended,
  // new root begins" signal, making every root unambiguously parallel to the
  // dispatch head. A pure flat-leaf turn (no NESTING root) keeps the clean
  // 3-space lead — there is no spine to collide with, so the marker would be
  // gratuitous noise on the common case. Mirrors the "each root anchors its
  // own col-0 ◉ / blank marker" note in tool-lane-render-children.ts. The
  // scrollback commit path groups same-tool flat roots into one labeled
  // `×N` line (renderGroupedRootTools), which is not orphan-prone, so it is
  // intentionally left at the 3-space lead — only the live overlay renders
  // flat roots as separate rows that can collide with a sibling spine.
  const hasNestingRoot = visibleRoots.some((e) => NESTING_TOOLS.has(e.toolName));
  // flatRootLead: when NESTING roots are present, flat roots anchor with ◉ to
  // maintain topology alignment. Completed flat roots (result set) use dimCompleted
  // so done rows recede; active flat roots use activeAgent so the in-flight tool
  // name is clearly readable. The lead is split below at the call sites.
  const flatRootLeadActive = hasNestingRoot ? palette.activeAgent(g.turnRoot) : '   ';
  const flatRootLeadDone = hasNestingRoot ? palette.dimCompleted(g.turnRoot) : '   ';

  for (const entry of visibleRoots) {
    const firstRow = lines.length;
    const children = childMap.get(entry.toolUseId);

    // Dispatch-tools (Agent/Task/agent/compose) own nested children — render
    // their indented child block. Other tools render a flat line with result
    // (if any) or a dim "in-progress" marker.
    //
    // Turn-root marker: dispatch heads use `◉  ` (or `o  ` in ASCII) at col 0
    // instead of the bare `'   '` lead. The spine column drawn by
    // renderOverlayChildren below sits underneath at col 0, so the marker
    // visually anchors the topology spine for this subagent block.
    // Width invariant: `g.turnRoot` is 3 cells (same as the prior lead),
    // so child columns line up unchanged.
    if (NESTING_TOOLS.has(entry.toolName) && children && children.length > 0) {
      renderNestingWithChildren(entry, children, childMap, lines, g, cols, fade);
    } else if (NESTING_TOOLS.has(entry.toolName) && entry.headerEmitted) {
      // NESTING_TOOL ancestor with no in-flight children left in the lane
      // (all descendants flushed to scrollback). Header is already in
      // scrollback from the earlier flushSource — render nothing in the
      // overlay. The ancestor will be removed from the lane when it itself
      // completes via dispose-time `flush()` (which already respects
      // headerEmitted by emitting only the closer).
    } else if (NESTING_TOOLS.has(entry.toolName)) {
      renderNestingChildless(entry, lines, g, cols, activeTools);
    } else {
      renderFlatRoot(entry, lines, g, cols, flatRootLeadActive, flatRootLeadDone, activeTools, flash);
    }

    fade?.fadeLines(entry.toolUseId, lines, firstRow);
  }

  if (hiddenDoneCount > 0) {
    // Structural summary of elided completed roots — dimCompleted is correct here.
    const clamp = (line: string): string => truncateDisplayWidth(line, cols);
    lines.push(clamp('   ' + palette.dimCompleted(`… +${hiddenDoneCount} done`)));
  }

  return joinOverlayLines(lines); // centering margin applied inside (see tool-lane-flush-margin.ts)
}
