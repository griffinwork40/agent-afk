import { palette } from '../../palette.js';
import { NESTING_TOOLS } from '../../tool-category.js';
import { getTerminalWidth } from '../../terminal-size.js';
import {
  MAX_VISIBLE_CHILDREN,
  inProgressVerb,
  formatOutcome,
  formatDiffBlock,
  doneGlyph,
  sanitizeLabel,
} from './tool-lane-format.js';
import type { ToolEntry, TextEntry, Entry, Glyphs } from './tool-lane-render.js';
import {
  buildIndent,
  clampLineToTerminal,
  colorizeIndent,
  renderTextChildLines,
  getGlyphs,
} from './tool-lane-render.js';
import {
  groupSiblings,
  addOverflowSynthetic,
  addResultSummarySynthetic,
  assignConnectors,
  formatGroupedSibling,
} from './tool-lane-render-grouping.js';
/**
 * Calculate the indent for text children based on ancestor tree state.
 *
 * Text children appear AFTER all tool siblings (which may close with a last
 * connector ╰─). When tool siblings were rendered, we extend the ancestor
 * vector with `true` to model that final `╰─`, so text children don't
 * visually re-open a closed branch. When no tool siblings rendered, we
 * reuse the original indent to avoid phantom spine columns.
 */
function calculateTextIndent(
  toolChildrenCount: number,
  agentResultSummaryPresent: boolean,
  ancestorIsLast: readonly boolean[],
  g: Readonly<Glyphs>,
): string {
  const hasToolOrSummary = toolChildrenCount > 0 || agentResultSummaryPresent;
  return hasToolOrSummary
    ? buildIndent([...ancestorIsLast, true], g)
    : buildIndent(ancestorIsLast, g);
}

// Invariant: a NESTING_TOOLS child (skill / Agent / compose) whose header was
// already eagerly committed to scrollback (`headerEmitted === true`) AND whose
// in-lane subtree contains NO VISIBLE DESCENDANT must render NOTHING in the live
// overlay — its labeled header lives in scrollback above.
//
// "No visible descendant" is recursive: a grandchild is visible when it is either
// (a) a TextEntry, (b) a non-nesting ToolEntry, or (c) a nesting ToolEntry that
// is itself NOT silenced (i.e. has at least one visible descendant). Equivalently,
// a nesting header is silenced only when every() grandchild is also silenced.
// `every()` on an empty array is vacuously true, preserving the base case: no
// grandchildren → silenced.
//
// Why pre-filter rather than skip inside the render loop:
// Connectors are assigned purely by sibling position (assignConnectors: last →
// `╰─`, others → `├─`). A child silenced AFTER assignment still consumes a
// connector slot: when it was the LAST sibling, the preceding visible sibling kept
// a mid `├─` and an open continuation column pointing at a row that never renders
// — a dangling spine. Filtering up front lets assignConnectors recompute `╰─` onto
// the true last VISIBLE sibling.
//
// Depth-2 example that requires recursion:
//   skill1 → agent1 → [tool1, skill2 → agent2 → agent3 → tool3]
// After flushSource('agent3'), agent3+tool3 are removed and all ancestors get
// headerEmitted=true. agent2 has 0 children → silenced (base case). skill2 has
// 1 child (agent2, still in lane) → the old length===0 check returned false →
// NOT silenced → skill2 occupied a connector slot → tool1 got ├─ instead of ╰─,
// leaving a dangling open continuation pointing at the empty anchor below it.
// With recursion: skill2's only grandchild (agent2) is itself silenced → skill2
// is silenced → pre-filtered → assignConnectors places ╰─ on tool1.
//
// Mirror of the root-level guard in ToolLane.getOverlay, which is naturally
// immune to this because roots carry no positional `├─`/`╰─` connectors (each
// root anchors its own col-0 `◉` / blank marker).
function isSilencedNestingHeader(child: ToolEntry, childMap: Map<string, Entry[]>): boolean {
  if (!NESTING_TOOLS.has(child.toolName) || child.headerEmitted !== true) return false;
  const grandchildren = childMap.get(child.toolUseId) ?? [];
  // every() on [] is vacuously true → preserves the base case (no grandchildren).
  // A TextEntry grandchild or a non-silenced ToolEntry grandchild short-circuits to false.
  return grandchildren.every((gc) => gc.kind === 'tool' && isSilencedNestingHeader(gc, childMap));
}

function renderOverlayChildren(
  children: Entry[],
  childMap: Map<string, Entry[]>,
  lines: string[],
  // Hoist getTerminalWidth() to a single read per top-level invocation.
  // Default at the parameter site keeps external callers signature-compatible
  // (they call with no cols, get a fresh read); recursive call below threads
  // the captured value to avoid repeated reads.
  cols: number = getTerminalWidth(),
  // `ancestorIsLast[i]` = true iff the ancestor column at slot i has closed
  // (its branch ended above this row) → render `g.spineClosed`; false →
  // render an open `g.spine` (`│`). Default `[]` for the depth-1 entrypoint
  // (no ancestor columns yet; the immediate parent is the active spine,
  // rendered on the row above by the caller).
  ancestorIsLast: readonly boolean[] = [],
  // Active glyph set (Unicode default, ASCII via AGENT_AFK_ASCII=1). Default
  // reads env once per top-level call; recursion threads the captured value
  // so all rows of one render frame share the same set.
  g: Readonly<Glyphs> = getGlyphs(),
  // Contract: last-ness of the IMMEDIATE PARENT — the node whose children are
  // being rendered here (the active-spine owner). Threaded so that when we
  // recurse, that parent's column reflects ITS OWN last-ness, not the
  // last-ness of whichever child we descend into. `undefined` at a local-root
  // entry (turn-root / Agent head row), where the parent's column is instead
  // derived from which child-subtree we descend into. See the recursion below.
  parentIsLast?: boolean,
): void {
  // Plain (no-ANSI) indent: lead + ancestor slots + active spine column.
  // `.length` measures display cells correctly (composed of 2-cell units).
  const indent = buildIndent(ancestorIsLast, g);
  const indentColored = colorizeIndent(indent, g);

  // Last block wins: render any text children AFTER tool children (typically
  // at most one). Don't count text children against the tool overflow budget.
  // Order rationale: a subagent emits tool_use blocks BEFORE its assistant-text
  // narration (the narration is the model's summary/handoff after the tools
  // returned). Rendering text last preserves that temporal order in the
  // visual layout and keeps the most recent narration visually adjacent to
  // the Agent's eventual Done line.
  const textChildren = children.filter((c): c is TextEntry => c.kind === 'text');
  const toolChildren = children
    .filter((c): c is ToolEntry => c.kind === 'tool')
    .filter((c) => !isSilencedNestingHeader(c, childMap));

  const grouped = groupSiblings(toolChildren);
  // Apply overflow synthetic before assignConnectors so the overflow line
  // obeys the same last-child connector rule as any real sibling.
  const withOverflow = addOverflowSynthetic(grouped, MAX_VISIBLE_CHILDREN);
  const connected = assignConnectors(withOverflow, g);

  for (const { sibling: item, connector: rawConnector } of connected) {
    const connector = palette.dim(rawConnector);
    // Whether THIS row's owning sibling is last at its level — drives
    // both connector glyph (already chosen by assignConnectors) and the
    // ancestor-isLast vector for any recursive call. Compare against the
    // active glyph set's lastConnector (Unicode `'╰─ '` or ASCII `'\\- '`).
    const isLast = rawConnector === g.lastConnector;

    if (item.kind === 'overflow') {
      lines.push(clampLineToTerminal(indentColored + connector + palette.dim(item.text), cols));
    } else if (item.kind === 'group') {
      lines.push(clampLineToTerminal(indentColored + connector + formatGroupedSibling(item), cols));
    } else if (item.kind === 'resultSummary') {
      // resultSummary synthetics are not added for the overlay path (no
      // agentResultSummary in the overlay context), but handle gracefully.
      // `.summary` is PRE-STYLED by summaryWithBatchBadge (dim base + self-dim
      // batch badge) — emit verbatim; re-dimming would nest the badge's dim.
      lines.push(clampLineToTerminal(indentColored + connector + item.summary, cols));
    } else {
      const child = item;
      const grandchildren = childMap.get(child.toolUseId);
      if (NESTING_TOOLS.has(child.toolName) && grandchildren && grandchildren.length > 0) {
        // Invariant: a NESTING dispatch head (skill / Agent / compose) with
        // in-lane grandchildren is anchored with a tree CONNECTOR (`├─` / `╰─`),
        // same as any sibling, and the recursion below threads the head's own
        // `isLast` so a LAST-child head CLOSES its parent's column beneath it
        // (`╰─` sits over a blank `  `, never over an open `│`).
        //
        // Why isLast (close-below), not always-open: the live overlay is
        // EPHEMERAL — re-rendered from scratch every frame — so `isLast` always
        // reflects the CURRENT sibling order. If the parent later spawns another
        // child, the next frame redraws this head as `├─` and re-opens the
        // column. There is no append-only commitment to contradict, so closing
        // the column below a last-child `╰─` is just correct standard-tree
        // geometry. Keeping it OPEN (the prior always-open attempt) left a `│`
        // running beneath a `╰─` in the same column — a self-contradicting
        // severed spine that made the nested tool-use loop read as floating,
        // detached from the dispatch above it (the reported regression).
        //
        // Seam note (deliberate): the COMMITTED band anchors dispatch heads with
        // the `◉` marker (formatAgentSummary) and keeps live-ancestor columns
        // OPEN, because it is APPEND-ONLY — it cannot guess a live ancestor's
        // last child without risking fragmentation when a later wave arrives
        // (see ToolLane.flushSource). So the overlay (closes below a last child)
        // and the band (stays open) intentionally differ at the scrollback↔
        // overlay seam. Acceptable: the two surfaces are ephemeral vs append-only
        // and essentially never adjacent on screen, whereas a severed spine
        // WITHIN the live frame is always visible.
        //
        // headerEmitted (anonymous anchor): when flushSource() already committed
        // this head's labeled row to scrollback, omit the label here — emit the
        // connector glyph alone so grandchildren still have a real parent row to
        // attach to (Bug A) and the recursive ancestor vector keeps a matching
        // visual row per slot (Bug B / orphan │ columns), without restating the
        // committed label. Use `indentColored` (not raw `indent`) so spine
        // columns stay dim — a non-colored row at depth N leaves a visible gap.
        if (child.headerEmitted) {
          // Anonymous anchor: connector glyph only, no label body (the labeled
          // header lives in scrollback above).
          lines.push(clampLineToTerminal(indentColored + connector, cols));
        } else {
          lines.push(clampLineToTerminal(indentColored + connector + child.prefix, cols));
        }
        // Recurse: as we descend, the CURRENT parent (whose children we are
        // rendering) becomes a tracked ancestor column. That column must reflect
        // the CURRENT PARENT's own last-ness (`parentIsLast`), NOT `child.isLast`
        // — otherwise a non-last parent whose last child has its own children
        // gets its spine column closed one row too early (severing it from its
        // next sibling). At a local-root entry (`parentIsLast === undefined`,
        // i.e. a turn-root / Agent head) the parent's column is instead derived
        // from which child-subtree we descend into (`isLast`), which is correct:
        // the root spine closes only inside its last child's subtree. We thread
        // `isLast` down as the NEW `parentIsLast` so `child` itself is tracked
        // correctly one level deeper. `g` keeps one glyph set for the frame.
        const parentSlot = parentIsLast ?? isLast;
        renderOverlayChildren(grandchildren, childMap, lines, cols, [...ancestorIsLast, parentSlot], g, isLast);
        // Render the thinking-tail AFTER the grandchildren so the in-flight
        // narration sits below the subagent's tool calls (mirrors text-child
        // ordering below; matches the temporal order the model emitted them).
        if (child.thinkingTail) {
          // Clamp: thinkingTail is unbounded model narration — without clamp the
          // assembled indent + tail overflows terminal width and the terminal
          // hard-wraps to col 0 with no tree gutter (see clampLineToTerminal
          // docstring above for the orphaned-continuation failure mode).
          //
          // Invariant: use the grandchild-frame indent ([...ancestorIsLast,
          // parentSlot]) so the `⌇` glyph aligns with the `├` / `╰` connectors
          // emitted on the grandchild rows — which recurse with the SAME
          // `parentSlot` value above. Using the current frame's `indentColored`
          // ([...ancestorIsLast]) was one slot too shallow. `clampLineToTerminal`
          // → `truncateDisplayWidth` is ANSI-aware.
          const tailIndentColored = colorizeIndent(buildIndent([...ancestorIsLast, parentSlot], g), g);
          lines.push(clampLineToTerminal(tailIndentColored + palette.thinking('⌇  ' + sanitizeLabel(child.thinkingTail)), cols));
        }
      } else if (NESTING_TOOLS.has(child.toolName) && child.headerEmitted) {
        // Invariant: committed labels live in scrollback; live overlay must
        // render nothing for a NESTING_TOOLS child whose header has already
        // been eagerly committed (headerEmitted = true) AND whose in-lane
        // children have all been removed (no grandchildren). This is the
        // nested mirror of the same silence branch in ToolLane.getOverlay
        // (tool-lane.ts ~391-397) which handles the root-level case:
        //
        //   "NESTING_TOOL ancestor with no in-flight children left in the
        //    lane (all descendants flushed to scrollback). Header is already
        //    in scrollback from the earlier flushSource — render nothing."
        //
        // Without this branch the code falls through to `child.result` or
        // the `else` (in-progress) path and emits `connector + child.prefix`
        // — re-rendering the committed label AND an in-progress verb that
        // belongs to a frame already in scrollback. The broken output reads
        // as a bare `◆ skill(...)` row at the wrong sibling position, and
        // siblings that follow are displaced one level too deep because the
        // phantom row occupies a connector slot without representing any
        // real in-flight work.
        //
        // No visual row is emitted: the parent frame for this child is
        // already in scrollback (with its children committed there); there
        // are no in-flight descendants to anchor; and the sibling after this
        // child will draw its own connector row from the current parent's
        // indented spine column — exactly what the caller renders next.
      } else if (child.result) {
        lines.push(clampLineToTerminal(indentColored + connector + child.prefix + palette.dim(' — ') + doneGlyph(child.result.isError) + ' ' + formatOutcome(child.result, undefined, 60, child.toolName), cols));
        if (child.diff && !child.result.isError) {
          // Diff sits under the child entry. Indent = current row's indent
          // + 1 spine slot (continuing this child's column iff it's not the
          // last sibling) + a 1-cell pad to clear past the connector. We
          // approximate the post-connector position with `'    '` extension
          // since the connector itself is 3 cells (`├─ ` / `╰─ `) — the diff
          // hangs visually past it without claiming a sibling slot.
          const diffIndent = indentColored + (isLast ? g.spineClosed : palette.dim(g.spine)) + '  ';
          // Clamp each diff body line to terminal width. Diff lines are
          // model-controlled (file content) and routinely exceed `cols`;
          // without clamping the terminal soft-wraps the overflow to column 0
          // with no spine gutter, orphaning a flush-left continuation between
          // siblings (the same orphan-wrap bug every other row-producing path
          // here guards against). In the live overlay an unclamped wrap also
          // desyncs the compositor's logical-line row accounting from
          // log-update's wrap-aware count, making the block flicker on each
          // repaint. Mirrors the clamp on the root-overlay diff path in
          // tool-lane.ts.
          for (const line of formatDiffBlock(child.diff, 'overlay', diffIndent)) {
            lines.push(clampLineToTerminal(line, cols));
          }
        }
      } else {
        lines.push(clampLineToTerminal(indentColored + connector + child.prefix, cols));
        // In-progress / thinking continuation hangs under the prefix at the
        // same "past-connector" column the diff path uses.
        const continuationIndent = indentColored + (isLast ? g.spineClosed : palette.dim(g.spine)) + '  ';
        if (child.thinkingTail) {
          // Clamp: see note at the NESTING_TOOLS branch above — thinkingTail is
          // unbounded narration; terminal hard-wrap orphans the continuation.
          // `continuationIndent` carries the topology-spine column (colored);
          // clampLineToTerminal → truncateDisplayWidth is ANSI-aware.
          lines.push(clampLineToTerminal(continuationIndent + palette.thinking('⌇ ' + sanitizeLabel(child.thinkingTail)), cols));
        } else {
          lines.push(clampLineToTerminal(continuationIndent + palette.dim(inProgressVerb(child.toolName)), cols));
        }
      }
    }
  }

  // Text-child narration renders AFTER all tool children. A subagent's
  // assistant text is its summary/handoff after the tools returned —
  // visually following the tools matches that temporal order and keeps the
  // latest narration adjacent to the eventual Done line.
  //
  // Indent uses `[...ancestorIsLast, true]` — text children appear AFTER
  // the last tool sibling (which carries `╰─`, closing the current parent's
  // spine column). Reusing `indent` here would emit `│` at the same column
  // that `╰─` just closed, visually re-opening a closed branch and severing
  // the topology spine between the parent's last `╰─` and any subsequent
  // sibling rendered below this frame.
  //
  // Guard: only apply the `[...ancestorIsLast, true]` extension when tool
  // siblings were actually rendered — the appended `true` models a `╰─`
  // connector that was emitted. When no tool siblings rendered, no connector
  // was emitted and the extension would add a phantom `spineClosed` slot (2
  // cells), indenting text children 2 characters too wide.
  //
  // Clamp each emitted line: `renderTextChildLines` wraps with
  // `wrapToWidth(hard:false)`, which leaves unbroken tokens wider than
  // maxWidth on one line. The composed `indent + prefix + token` can then
  // exceed `cols` and trigger terminal hard-wrap to col 0 with no gutter —
  // an orphaned flush-left continuation between the narration row and the
  // next rendered sibling. Mirrors the pattern used for every other
  // row-producing path in this function (lines 712, 714, 718, 748, 750,
  // 767, 770, 784, 793, 795).
  const textIndent = calculateTextIndent(toolChildren.length, false, ancestorIsLast, g);
  for (const text of textChildren) {
    for (const line of renderTextChildLines(text.text, textIndent, g)) {
      lines.push(clampLineToTerminal(line, cols));
    }
  }
}

/**
 * Render settled children for scrollback (flush path).
 *
 * Pipeline (tree-connector contract, §4 of desired-state doc):
 *   1. Build grouped sibling list from real tool children.
 *   2. `addOverflowSynthetic` — inserts overflow placeholder if needed.
 *   3. `addResultSummarySynthetic` — inserts Done summary as the LAST sibling.
 *   4. `assignConnectors` — assigns `'└ '` to last, `'├ '` to all prior.
 *   5. Render each connected sibling.
 *
 * Constraint: the `agentResultSummary` synthetic must be added BEFORE
 * `assignConnectors` runs so it is treated as the true last sibling and
 * receives the `'└ '` connector. Adding it after (as was done pre-2b with
 * a hardcoded `'⎿'`) is Bug #5.
 */
function renderFlushChildren(
  children: Entry[],
  childMap: Map<string, Entry[]>,
  homeDir?: string,
  agentResultSummary?: string,
  // Hoist getTerminalWidth() to a single read per top-level invocation.
  // Recursive call below threads the captured value through.
  cols: number = getTerminalWidth(),
  // Mirror {@link renderOverlayChildren}: track last-ness of each ancestor
  // so the spine column closes correctly when a parent was last at its level.
  ancestorIsLast: readonly boolean[] = [],
  // Active glyph set (Unicode default, ASCII via AGENT_AFK_ASCII=1). Default
  // reads env once per top-level call; recursion threads the captured value
  // so all rows of one flush frame share the same set.
  g: Readonly<Glyphs> = getGlyphs(),
  // Mirror {@link renderOverlayChildren}: last-ness of the immediate parent
  // (the node whose children are rendered here). Threaded on recursion so a
  // tracked ancestor column reflects ITS OWN last-ness rather than its child's.
  // `undefined` at a local-root entry (Agent head via formatAgentSummary /
  // formatAgentChildren), where the parent's column is child-derived.
  parentIsLast?: boolean,
): string[] {
  const indent = buildIndent(ancestorIsLast, g);
  const indentColored = colorizeIndent(indent, g);
  const lines: string[] = [];

  const textChildren = children.filter((c): c is TextEntry => c.kind === 'text');
  const toolChildren = children.filter((c): c is ToolEntry => c.kind === 'tool');

  // Step 1: group siblings (text children render AFTER tools — see end of fn).
  const grouped = groupSiblings(toolChildren);
  // Step 2: overflow synthetic (before assignConnectors)
  const withOverflow = addOverflowSynthetic(grouped, MAX_VISIBLE_CHILDREN);
  // Step 3: result-summary synthetic (before assignConnectors, making it last)
  const withSummary = addResultSummarySynthetic(withOverflow, agentResultSummary);
  // Step 4: assign connectors — last item gets the LAST connector, all prior get MID.
  const connected = assignConnectors(withSummary, g);

  // Step 5: render
  for (const { sibling: item, connector: rawConnector } of connected) {
    const connector = palette.dim(rawConnector);
    const isLast = rawConnector === g.lastConnector;

    if (item.kind === 'overflow') {
      lines.push(clampLineToTerminal(indentColored + connector + palette.dim(item.text), cols));
    } else if (item.kind === 'resultSummary') {
      // LAST connector from assignConnectors — not a hardcoded '⎿' (that was Bug #5).
      // `.summary` is PRE-STYLED by summaryWithBatchBadge (dim base + self-dim
      // batch badge) — emit verbatim; re-dimming would nest the badge's dim.
      lines.push(clampLineToTerminal(indentColored + connector + item.summary, cols));
    } else if (item.kind === 'group') {
      lines.push(clampLineToTerminal(indentColored + connector + formatGroupedSibling(item), cols));
    } else {
      const child = item;
      const grandchildren = childMap.get(child.toolUseId);
      if (NESTING_TOOLS.has(child.toolName) && grandchildren && grandchildren.length > 0) {
        // External constraint (append-only scrollback): mirror of the same
        // guard in `renderOverlayChildren` (~line 753) and at the top-level
        // flush() / flushSource() paths in tool-lane.ts (lines 741, 566). If
        // this child's header was already eagerly committed to scrollback by
        // an earlier `flushSource()` walk (marking `headerEmitted = true`),
        // we must NOT re-emit the full prefix row here — that would land the
        // header in scrollback twice. Emit a dim breadcrumb placeholder
        // instead so:
        //   (a) grandchildren connectors anchor to a real rendered parent row
        //       (not a phantom — Bug A),
        //   (b) the ancestorIsLast vector pushed to the recursive call has a
        //       matching visual row for each slot (Bug B / orphan │ columns).
        if (child.headerEmitted) {
          const refLabel = child.toolInput
            ? `${child.toolName} ${sanitizeLabel(child.toolInput)}`
            : child.toolName;
          lines.push(clampLineToTerminal(indentColored + connector + palette.dim('↳ ' + refLabel), cols));
        } else {
          lines.push(clampLineToTerminal(indentColored + connector + child.prefix, cols));
        }
        // The current parent transitions to a tracked ancestor column here; it
        // must reflect the PARENT's own last-ness (`parentIsLast`), not this
        // child's, so a non-last ancestor's spine stays continuous through a
        // last child's subtree. At a local-root entry (`parentIsLast`
        // undefined — Agent head) the column is child-derived via `isLast`.
        // Mirrors renderOverlayChildren's recursion exactly so band ↔ overlay
        // descendant rows agree. Thread `isLast` down as the new `parentIsLast`.
        const parentSlot = parentIsLast ?? isLast;
        lines.push(...renderFlushChildren(grandchildren, childMap, homeDir, undefined, cols, [...ancestorIsLast, parentSlot], g, isLast));
      } else if (child.result) {
        lines.push(clampLineToTerminal(indentColored + connector + child.prefix + palette.dim(' — ') + doneGlyph(child.result.isError) + ' ' + formatOutcome(child.result, homeDir, 60, child.toolName), cols));
        if (child.diff && !child.result.isError) {
          // Scrollback renders the full diff (no overlay cap). Indent matches
          // the overlay path: continue (or close) this child's spine column,
          // then 2 cells past the connector.
          const diffIndent = indentColored + (isLast ? g.spineClosed : palette.dim(g.spine)) + '  ';
          // Clamp each diff body line to terminal width — see the matching
          // note on the overlay diff path above. Scrollback is append-only:
          // an unclamped line that soft-wraps to column 0 orphans its
          // continuation past the spine gutter permanently, with no repaint
          // able to repair it.
          for (const line of formatDiffBlock(child.diff, 'flush', diffIndent)) {
            lines.push(clampLineToTerminal(line, cols));
          }
        }
      } else {
        lines.push(clampLineToTerminal(indentColored + connector + child.prefix, cols));
      }
    }
  }

  // Text-child narration renders AFTER all tool children (and after the
  // resultSummary synthetic if any). A subagent's assistant text is its
  // summary/handoff emitted after the tool_use blocks; visually placing it
  // below the tools preserves that temporal order. Uses the `│ ` gutter
  // prefix instead of tree connectors — it's a prose continuation, not a
  // tree sibling.
  //
  // Indent uses `[...ancestorIsLast, true]` — text children appear AFTER
  // the last tool sibling (which carries `╰─`, closing the current parent's
  // spine column). Reusing `indent` here would emit `│` at the same column
  // that `╰─` just closed, visually re-opening a closed branch and severing
  // the topology spine in scrollback (where rows are append-only and can't
  // be repaired after emission).
  //
  // Guard: only apply the `[...ancestorIsLast, true]` extension when tool
  // siblings were actually rendered — the appended `true` models a `╰─`
  // connector that was emitted. When no tool siblings rendered, no connector
  // was emitted and the extension would add a phantom `spineClosed` slot (2
  // cells), indenting text children 2 characters too wide.
  //
  // Clamp each emitted line: see the matching note at the overlay path
  // textChildren loop above for the wrapToWidth(hard:false) overflow
  // mechanism. Mirror of the same pattern used by every other
  // row-producing path in this function (lines 863, 866, 868, 889, 891,
  // 895, 906).
  const textIndent = calculateTextIndent(toolChildren.length, agentResultSummary != null, ancestorIsLast, g);
  for (const text of textChildren) {
    for (const line of renderTextChildLines(text.text, textIndent, g)) {
      lines.push(clampLineToTerminal(line, cols));
    }
  }

  return lines;
}

export { renderOverlayChildren, renderFlushChildren };
