/**
 * Overlay rendering for the ToolLane.
 *
 * Extracted from tool-lane.ts to keep that file under the 350-code-line
 * ceiling. Contains the `renderToolLaneOverlay` function — the full live-
 * frame rendering path that `ToolLane.getOverlay()` delegates to.
 *
 * Invariant: this module owns no mutable state. All state is passed in by
 * the caller (ToolLane) and nothing here writes back to it.
 */

import { palette } from '../../palette.js';
import { NESTING_TOOLS } from '../../tool-category.js';
import { toolCard } from '../../render/tool-card.js';
import {
  formatOutcome,
  formatDiffBlock,
  formatPreviewDiffBlock,
  doneGlyph,
  sanitizeLabel,
  batchBadge,
  isBenignFailure,
} from './tool-lane-format.js';
import { truncateDisplayWidth } from '../../display.js';
import { formatElapsed } from '../../terminal-compositor.scrollback.js';
import {
  renderOverlayChildren,
  getGlyphs,
  toolLaneWidth,
  type ToolEntry,
  type Entry,
} from './tool-lane-render.js';

/** Maximum number of root-level entries shown in the live overlay. */
export const MAX_OVERLAY_ROOTS = 6;

/**
 * Render the live overlay string from a snapshot of ToolLane state.
 *
 * Contract: pure render — reads `order` and `entries` but never mutates
 * them. `childMap` is pre-built by the caller to avoid redundant walks.
 *
 * @param order    - Insertion-ordered list of all entry IDs.
 * @param entries  - Map from ID to Entry (tool or text).
 * @param childMap - Pre-built map from parent ID to child entries.
 * @returns        Newline-joined overlay string (empty string when no entries).
 */
export function renderToolLaneOverlay(
  order: readonly string[],
  entries: ReadonlyMap<string, Entry>,
  childMap: Map<string, Entry[]>,
): string {
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
  // overlay), then apply the MAX_OVERLAY_ROOTS sliding-window cap. The cap
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
  if (rootEntries.length > MAX_OVERLAY_ROOTS) {
    // Identify active (in-progress) roots — they bypass the cap.
    const activeRoots = rootEntries.filter((e) => !e.result);
    const doneRoots = rootEntries.filter((e) => e.result);
    // Reserve all active slots; fill remaining slots from the *tail* of
    // doneRoots (most recently completed), preserving original order.
    const doneBudget = Math.max(0, MAX_OVERLAY_ROOTS - activeRoots.length);
    const visibleDoneSet = new Set(doneRoots.slice(-doneBudget));
    hiddenDoneCount = doneRoots.length - visibleDoneSet.size;
    visibleRoots = rootEntries.filter((e) => !e.result || visibleDoneSet.has(e));
  }

  // Invariant: when the overlay mixes a NESTING root (skill / Agent / compose
  // — each anchors a col-0 ◉ turn-root marker and a descendant spine drawn at
  // col 0 by renderOverlayChildren) with flat-leaf roots, the flat roots must
  // ALSO anchor their own col-0 ◉. A flat leaf's bare 2-space lead places its
  // `●` glyph at col 2 (the NESTING block's depth-1 connector column) with a
  // BLANK col 0 — so a main-session read_file dispatched after a subagent
  // renders directly below a `│` spine with nothing in col 0, reading as a
  // severed / orphaned node that "fell out" of the subagent tree. Anchoring
  // col 0 with ◉ turns the `│ → ◉` transition into an honest "spine ended,
  // new root begins" signal, making every root unambiguously parallel to the
  // dispatch head. A pure flat-leaf turn (no NESTING root) keeps the clean
  // 2-space lead — there is no spine to collide with, so the marker would be
  // gratuitous noise on the common case. Mirrors the "each root anchors its
  // own col-0 ◉ / blank marker" note in tool-lane-render-children.ts. The
  // scrollback commit path groups same-tool flat roots into one labeled
  // `×N` line (renderGroupedRootTools), which is not orphan-prone, so it is
  // intentionally left at the 2-space lead — only the live overlay renders
  // flat roots as separate rows that can collide with a sibling spine.
  const hasNestingRoot = visibleRoots.some((e) => NESTING_TOOLS.has(e.toolName));
  const flatRootLead = hasNestingRoot ? palette.dim(g.turnRoot) : '  ';

  for (const entry of visibleRoots) {
    const children = childMap.get(entry.toolUseId);

    // Dispatch-tools (Agent/Task/agent/compose) own nested children — render
    // their indented child block. Other tools render a flat line with result
    // (if any) or a dim "in-progress" marker.
    //
    // Turn-root marker: dispatch heads use `◉ ` (or `o ` in ASCII) at col 0
    // instead of the bare `'  '` lead. The spine column drawn by
    // renderOverlayChildren below sits underneath at col 0, so the marker
    // visually anchors the topology spine for this subagent block.
    // Width invariant: `g.turnRoot` is 2 cells (same as the prior lead),
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
      // (`dim('◉ ')` / `dim('o ')`) — same 2-cell width as the live
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
        // label lives in scrollback above.
        lines.push(clamp(palette.dim(g.turnRoot)));
      } else {
        // Use g.turnRoot for the col-0 marker (◉ / o) so the spine column
        // aligns with the child rows below.
        lines.push(clamp(palette.dim(g.turnRoot) + entry.prefix));
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
      // Invariant: prefix is `dim(g.spine) + '⌇  '` (5 cells) — col 0
      // carries the Agent's live spine; the `⌇` glyph sits at col 2
      // (parallel to `├` / `╰` connector positions in child rows above);
      // two trailing pad cells (cols 3–4) land tail content at col 5,
      // aligned with the content column of the Agent's tool children
      // (`│ ╰─ <content>` also places content at col 5). Pre-fix layout
      // was `dim(g.spine) + g.spineClosed + '⌇ '` (6 cells), which
      // landed content at col 6 — one column right of children. The
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
      // from flush() for this same failure mode (see the History note on the
      // "subagents escape the skill frame" regression at flush() below). The
      // overlay path was the lone surface that still gated on child count.
      //
      // The outcome (completed) or " …" (in-flight) is appended to the head
      // row since there are no child rows to carry it. A NESTING dispatch
      // never carries a `diff` payload (diffs originate from edit/write
      // tool_diff chunks), so no diff block is rendered here.
      if (entry.result) {
        lines.push(clamp(palette.dim(g.turnRoot) + entry.prefix + palette.dim(' — ') + doneGlyph(entry.result.isError, entry.result.failureClass) + ' ' + formatOutcome(entry.result, undefined, 60, entry.toolName) + batchBadge(entry.result)));
      } else {
        // Live elapsed counter: computed at repaint time so the counter ticks
        // on every overlay refresh without a dedicated timer. Grace period
        // (ELAPSED_GRACE_MS = 2s) suppresses the counter for fast tools.
        lines.push(clamp(palette.dim(g.turnRoot) + entry.prefix + palette.dim(' …') + formatElapsed(entry.startedAt)));
      }
      // Mirror the thinkingTail handling of the other two NESTING branches
      // (and the childless-leaf branch below): spine glyph (g.spine, │) at
      // col 0, ⌇ continuation glyph at col 2, so in-flight narration aligns
      // under the head row instead of leading with bare whitespace.
      if (entry.thinkingTail) {
        lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
      }
    } else {
      if (entry.result) {
        // Flat-root completion: render via toolCard(collapsed:true) so the
        // live overlay shows a single badge+name+elapsed+outcome line without
        // the body block that the expanded card would add.  The lead glyph
        // (flatRootLead) is prepended so col-0 anchoring is unchanged.
        //
        // Status mapping mirrors doneGlyph / isBenignFailure: error+benign →
        // 'blocked' (⊘), error+unknown → 'error' (✗), no-error → 'done' (✓).
        // toolCard uses the same statusBadge helper as doneGlyph, so glyph
        // output is byte-for-byte identical to the prior inline call.
        const cardStatus = entry.result.isError
          ? (isBenignFailure(entry.result.failureClass) ? 'blocked' : 'error')
          : 'done';
        const elapsed = Date.now() - entry.startedAt; // completed — capture final elapsed
        const outputPreview = formatOutcome(entry.result, undefined, 60, entry.toolName);
        const card = toolCard({
          toolName: entry.toolName,
          status: cardStatus,
          elapsed,
          inputSummary: entry.toolInput || undefined,
          outputPreview,
          collapsed: true,
          trailingSuffix: batchBadge(entry.result),
          width: cols,
        });
        lines.push(clamp(flatRootLead + card));
        if (entry.diff && !entry.result.isError) {
          // Diff hangs under the outcome line, indented one level deeper
          // (4 spaces) so it visually attaches to this tool entry.
          for (const line of formatDiffBlock(entry.diff, 'overlay', '    ')) {
            lines.push(clamp(line));
          }
        }
      } else {
        // Live elapsed counter: same pattern as the NESTING branch above —
        // computed at repaint time, suppressed under ELAPSED_GRACE_MS (2s).
        lines.push(clamp(flatRootLead + entry.prefix + palette.dim(' …') + formatElapsed(entry.startedAt)));
        if (entry.previewDiff) {
          // Pre-execution diff preview: formatPreviewDiffBlock renders ⟳ Proposed
          // and applies the AFK_SHOW_DIFFS=0 opt-out (returns [] when disabled).
          for (const line of formatPreviewDiffBlock(entry.previewDiff, '    ')) {
            lines.push(clamp(line));
          }
        }
        if (entry.thinkingTail) {
          // Childless leaf entries get the thinking tail right under the
          // " …" line. Prefix shape mirrors the NESTING_TOOLS branch:
          // `dim(g.spine) + '⌇  '` (5 cells) — col 0 = live spine, col 2 =
          // `⌇` (connector slot), cols 3–4 = pad, content at col 5. See
          // the Invariant note at the NESTING_TOOLS branch above for the
          // column-alignment rationale.
          lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
        }
      }
    }
  }

  if (hiddenDoneCount > 0) {
    lines.push(clamp('  ' + palette.dim(`… +${hiddenDoneCount} done`)));
  }

  return lines.join('\n');
}
