/**
 * Live overlay rendering for {@link ToolLane}.
 *
 * Extracted from `tool-lane.ts` so the overlay concern lives in a dedicated
 * module while the class retains a thin delegating method. The public surface
 * is {@link renderToolLaneOverlay}, which accepts the lane's data as plain
 * parameters and returns the fully composed overlay string.
 */

import { palette } from '../../palette.js';
import { NESTING_TOOLS } from '../../tool-category.js';
import {
  formatDiffBlock,
  formatPreviewDiffBlock,
  doneGlyph,
  sanitizeLabel,
  batchBadge,
  activeToolBadge,
  formatOutcome,
  childFailureBadge,
} from './tool-lane-format.js';
import { truncateDisplayWidth, stripAnsi, displayWidth } from '../../display.js';
import { formatElapsed } from '../../terminal-compositor.scrollback.js';
import {
  renderOverlayChildren,
  buildChildMap,
  getGlyphs,
  toolLaneWidth,
  pushOutcomeLines,
  joinOverlayLines,
  type ToolEntry,
  type Entry,
} from './tool-lane-render.js';
import { formatFlatRootCompletion } from './tool-lane-overlay-completion.js';
import type { ToolLaneFlash } from './tool-lane-flash.js';

/**
 * Render the live tool-lane overlay string.
 *
 * Pure function: all lane state is passed as parameters so the function is
 * testable in isolation and the `ToolLane` class remains the single owner of
 * state. The overlay is rebuilt from scratch on every frame (callers drive
 * repaint timing).
 *
 * @param entries         Live entry map (keyed by `toolUseId`).
 * @param order           Insertion-ordered list of `toolUseId` keys.
 * @param activeTools     Current parallel-activity snapshot, or `null`.
 * @param flash           Optional flash tracker for 150ms glyph pulses.
 * @param maxOverlayRoots Maximum number of root-level entries to show.
 */
export function renderToolLaneOverlay(
  entries: Map<string, Entry>,
  order: string[],
  activeTools: { activeCount: number; toolUseIds: Set<string>; toolIndex?: Map<string, number> } | null,
  flash: ToolLaneFlash | null,
  maxOverlayRoots: number,
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
  const clamp = (line: string): string => truncateDisplayWidth(line, cols);

  // Collect root-level tool entries (those rendered at the top of the
  // overlay), then apply the maxOverlayRoots sliding-window cap. The cap
  // protects long multi-tool turns from filling the screen with completed
  // rows. Active (no-result) roots are *always* kept so the user can see
  // what is currently running — only the oldest *completed* roots are
  // elided, summarized via a trailing "… +N done" line.
  const rootEntries: ToolEntry[] = [];
  for (const id of order) {
    const entry = entries.get(id);
    if (!entry || entry.kind !== 'tool' || entry.agentContext) continue;
    rootEntries.push(entry);
  }

  let visibleRoots: ToolEntry[] = rootEntries;
  let hiddenDoneCount = 0;
  if (rootEntries.length > maxOverlayRoots) {
    // Identify active (in-progress) roots — they bypass the cap.
    const activeRoots = rootEntries.filter((e) => !e.result);
    const doneRoots = rootEntries.filter((e) => e.result);
    // Reserve all active slots; fill remaining slots from the *tail* of
    // doneRoots (most recently completed), preserving original order.
    const doneBudget = Math.max(0, maxOverlayRoots - activeRoots.length);
    const visibleDoneSet = new Set(doneRoots.slice(-doneBudget));
    hiddenDoneCount = doneRoots.length - visibleDoneSet.size;
    visibleRoots = rootEntries.filter((e) => !e.result || visibleDoneSet.has(e));
  }

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
      // Invariant: committed labels live in scrollback; live overlay may
      // render anonymous anchors only to preserve tree geometry.
      //
      // External constraint (append-only scrollback): once `flushSource`
      // eagerly emits an ancestor header to scrollback (marking
      // `headerEmitted = true`), the overlay must NOT redraw any label
      // for that ancestor — the label is now in scrollback, and any
      // overlay-rendered re-statement of it reads as a duplicate of the
      // committed row. Mirror of the same guard already applied in
      // `flush()` (line ~540) and recursively in `renderOverlayChildren`
      // for nested ancestors.
      //
      // Anonymous-anchor invariant (headerEmitted branch, overlay path):
      // when the header is in scrollback but in-flight children remain,
      // emit a row that occupies the parent's column position but
      // carries NO label and NO ↳ back-reference glyph. The row exists
      // for geometry only — it gives the child rows below a real visual
      // row to point their `│ ├─` connectors at, so descendants don't
      // appear to float disconnected.
      //
      // At root depth the anchor is `palette.dim(g.turnRoot)` alone
      // (`dim('◉  ')` / `dim('o  ')`) — same 3-cell width as the live
      // header's marker, anchoring the spine column for child rows
      // below. No label, no ↳ glyph: the eye reads the row as pure
      // geometry, not as a "ghost" copy of the scrollback header.
      //
      // Why ◉ (the live-frame marker) and not `│` (a spine continuation
      // glyph)? The overlay isn't physically adjacent to the original
      // scrollback header — sibling-branch flushes and interleaved output
      // routinely sit between them. A `│ ` at the top of the overlay
      // would assert upward continuity that doesn't exist in scrollback.
      // ◉ claims nothing about upward; it only anchors the spine going
      // down. That stays honest under reordering.
      //
      // Both branches use `clamp()` to bound the row to terminal cols —
      // entry.toolInput and entry.prefix are model-controlled and may
      // overflow without explicit truncation.
      if (entry.headerEmitted) {
        // Anonymous anchor: marker only, no label body. The committed
        // label lives in scrollback above. Header was already committed so
        // this is structural geometry only — dim the marker.
        lines.push(clamp(palette.dimCompleted(g.turnRoot) + childFailureBadge(entry.failedChildCount)));
      } else if (entry.result) {
        // Completed nesting root whose children are still in the lane:
        // addResult() sets entry.result before the next overlay repaint,
        // so a completed parent must use dimCompleted — not activeAgent —
        // to maintain the active-vs-completed distinction.
        lines.push(clamp(palette.dimCompleted(g.turnRoot) + entry.prefix + childFailureBadge(entry.failedChildCount)));
      } else {
        // Active (in-flight) nesting root: use activeAgent for the ◉ marker
        // so the whole row is clearly readable. The entry.prefix (agent name
        // + args) is already colorized by formatToolLine with color.bold(name).
        lines.push(clamp(palette.activeAgent(g.turnRoot) + entry.prefix + childFailureBadge(entry.failedChildCount)));
      }
      renderOverlayChildren(children, childMap, lines, cols, undefined, g);
      // Render the thinking-tail AFTER the children so the subagent's
      // in-flight narration sits below its tool calls, not between the
      // Agent prefix and its first tool. Mirrors the text-child ordering
      // in renderOverlayChildren / renderFlushChildren.
      // Clamp: thinkingTail is unbounded narration; without clamp the
      // terminal hard-wraps to col 0 with no gutter, orphaning a flush-left
      // continuation between siblings (see clampLineToTerminal docstring).
      //
      // Invariant: prefix is `dim(g.spine) + '⌇  '` (6 cells) — col 0
      // carries the Agent's live spine; the `⌇` glyph sits at col 3
      // (parallel to `├` / `╰` connector positions in child rows above);
      // two trailing pad cells (cols 4–5) land tail content at col 6,
      // aligned with the content column of the Agent's tool children
      // (`│  ╰─ <content>` also places content at col 6). Pre-fix layout
      // was `dim(g.spine) + g.spineClosed + '⌇ '` (7 cells), which
      // landed content at col 7 — one column right of children. The
      // visual drift was inherited from PR #470's "match the old
      // 4-space prefix" goal; the spine survived but the column
      // alignment didn't. Mirrors the depth-N tail at
      // tool-lane-render.ts:767.
      if (entry.thinkingTail) {
        lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
      }
    } else if (NESTING_TOOLS.has(entry.toolName) && entry.headerEmitted) {
      // NESTING_TOOL ancestor with no in-flight children left in the lane
      // (all descendants flushed to scrollback). Header is already in
      // scrollback from the earlier flushSource — render nothing in the
      // overlay. The ancestor will be removed from the lane when it itself
      // completes via dispose-time `flush()` (which already respects
      // headerEmitted by emitting only the closer).
    } else if (NESTING_TOOLS.has(entry.toolName)) {
      // Invariant: a NESTING dispatch head (skill/Agent/compose) anchors the
      // topology spine with the turn-root marker (g.turnRoot, ◉) at col 0 —
      // ALWAYS, even when it owns no in-lane children. The two branches above
      // already handled "has children" and "headerEmitted, no children", so
      // this branch is the childless, NOT-yet-committed case: the head's
      // descendants were rooted separately or already flushed to scrollback,
      // leaving zero in-lane children. It is still a dispatch head and must
      // carry ◉ so child/sibling rows below have a real spine column to
      // attach to.
      //
      // Without this branch the entry falls through to the flat-leaf `else`
      // below and renders at a bare 2-space lead with no ◉ and no spine — a
      // NESTING row floating disconnected from the topology (the "broken
      // spine / floating skill row" bug). This mirrors flush()'s discriminant
      // exactly: NESTING membership alone routes to the frame head, never the
      // `children.length > 0` co-discriminant that was deliberately removed
      //
      // from flush() for this same failure mode (see the History note on the
      // "subagents escape the skill frame" regression at flush() below). The
      // overlay path was the lone surface that still gated on child count.
      //
      // The outcome (completed) or " …" (in-flight) is appended to the head
      // row since there are no child rows to carry it. A NESTING dispatch
      // never carries a `diff` payload (diffs originate from edit/write
      // tool_diff chunks), so no diff block is rendered here.
      if (entry.result) {
        // Completed nesting entry: dim the structural chrome — it is done.
        // pushOutcomeLines splits multi-line formatOutcome; headLine computed first so its display-width derives the outcome budget.
        const headLine = palette.dimCompleted(g.turnRoot) + entry.prefix + palette.dimCompleted(' — ') + doneGlyph(entry.result.isError, entry.result.failureClass) + ' ';
        pushOutcomeLines(lines, headLine, formatOutcome(entry.result, undefined, Math.max(20, cols - displayWidth(stripAnsi(headLine))), entry.toolName), palette.dimCompleted(g.spine) + '  ', cols, batchBadge(entry.result) + childFailureBadge(entry.failedChildCount));
      } else {
        // Active (in-flight) nesting entry: use activeAgent for ◉ so the agent
        // name row is clearly readable. The ' …' tail is structural/informational
        // — keep it dim so it recedes behind the agent identity.
        // Live elapsed counter: computed at repaint time so the counter ticks
        // on every overlay refresh without a dedicated timer. Grace period
        // (ELAPSED_GRACE_MS = 2s) suppresses the counter for fast tools.
        lines.push(clamp(palette.activeAgent(g.turnRoot) + entry.prefix + palette.dim(' …') + formatElapsed(entry.startedAt) + activeToolBadge(entry.toolUseId, activeTools) + childFailureBadge(entry.failedChildCount)));
      }
      // Mirror the thinkingTail handling of the other two NESTING branches
      // (and the childless-leaf branch below): spine glyph (g.spine, │) at
      // col 0, ⌇ continuation glyph at col 3, so in-flight narration aligns
      // under the head row instead of leading with bare whitespace.
      if (entry.thinkingTail) {
        lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
      }
    } else {
      if (entry.result) {
        // Completed flat-root: render via toolCard (collapsed) so the badge,
        // tool name, elapsed, and batch badge share the component's layout
        // contract. The flatRootLeadDone is prepended by the caller (this site)
        // so the lead stays outside the component's width budget — subtract
        // its display width from the card's column budget to prevent overflow.
        // Use finishedAt (frozen at result-arrival time) so elapsed doesn't
        // drift on every repaint; fall back to Date.now() for entries that
        // pre-date the finishedAt field (should not occur in practice).
        const elapsedMs = (entry.finishedAt ?? Date.now()) - entry.startedAt;
        const cardWidth = cols - displayWidth(flatRootLeadDone);
        const card = formatFlatRootCompletion(entry.toolName, entry.result, elapsedMs, batchBadge(entry.result), cardWidth);
        // Flash pulse: bold-wrap the card for 150ms after completion so the
        // glyph catches the eye in peripheral vision (issue: lane-flash).
        const flashedCard = flash?.isFlashing(entry.toolUseId) ? palette.bold(card) : card;
        lines.push(clamp(flatRootLeadDone + flashedCard));
        if (entry.diff && !entry.result.isError) {
          // Diff hangs under the outcome line, indented one level deeper
          // (4 spaces) so it visually attaches to this tool entry.
          for (const line of formatDiffBlock(entry.diff, 'overlay', '    ')) {
            lines.push(clamp(line));
          }
        }
      } else {
        // Active flat-root: use flatRootLeadActive so the in-flight tool name
        // is clearly readable. The ' …' tail is structural — keep it dim.
        // Live elapsed counter: same pattern as the NESTING branch above —
        // computed at repaint time, suppressed under ELAPSED_GRACE_MS (2s).
        lines.push(clamp(flatRootLeadActive + entry.prefix + palette.dim(' …') + formatElapsed(entry.startedAt) + activeToolBadge(entry.toolUseId, activeTools)));
        if (entry.previewDiff) {
          // Pre-execution diff preview: formatPreviewDiffBlock renders ⟳ Proposed
          // and applies the AFK_SHOW_DIFFS=0 opt-out (returns [] when disabled).
          for (const line of formatPreviewDiffBlock(entry.previewDiff, '    ')) {
            lines.push(clamp(line));
          }
        }
        if (entry.thinkingTail) {
          // Childless Agent entries (a child just opened its thinking block
          // and hasn't yet emitted content or a tool_use) get the tail right
          // under the " …" line — exactly the position the eventual first
          // child will occupy, so adding/removing the tail doesn't make the
          // overlay jump. Prefix shape mirrors the NESTING_TOOLS branch:
          // `dim(g.spine) + '⌇  '` (6 cells) — col 0 = live spine, col 3 =
          // `⌇` (connector slot), cols 4–5 = pad, content at col 6. See
          // the Invariant note at the NESTING_TOOLS branch above for the
          // column-alignment rationale.
          lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
        }
        if (entry.outputTail) {
          // Live bash output tail (issue #1506): last N lines of stdout/stderr,
          // rendered as dim italic continuation lines under the in-flight row.
          // Ephemeral overlay only — never reaches scrollback or the model.
          // Each tail line is indented 5 spaces to align with the tool content
          // column (matching the previewDiff/thinkingTail indent), clamped to
          // the terminal width to prevent soft-wrap from orphaning a flush-left
          // continuation between siblings.
          for (const tailLine of entry.outputTail.split('\n')) {
            if (tailLine.length > 0) {
              lines.push(clamp('     ' + palette.dim(sanitizeLabel(tailLine))));
            }
          }
        }
      }
    }
  }

  if (hiddenDoneCount > 0) {
    // Structural summary of elided completed roots — dimCompleted is correct here.
    lines.push(clamp('   ' + palette.dimCompleted(`… +${hiddenDoneCount} done`)));
  }

  return joinOverlayLines(lines); // centering margin applied inside (see tool-lane-flush-margin.ts)
}
