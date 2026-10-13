/**
 * Root-entry rendering helpers for {@link renderToolLaneOverlay}.
 *
 * Extracted from `tool-lane-overlay.ts` to bring `renderToolLaneOverlay`
 * under the 200-line function ceiling (issue #3478). Each helper handles
 * exactly one branch of the root-entry discriminant and takes only explicit
 * parameters — no closures over enclosing locals.
 *
 * Public surface: three named helpers consumed by `tool-lane-overlay.ts`.
 * All invariant comments from the original are preserved next to the code
 * they govern.
 */

import { palette } from '../../palette.js';
import {
  formatDiffBlock,
  formatPreviewDiffBlock,
  doneGlyph,
  sanitizeLabel,
  batchBadge,
  activeToolBadge,
  childFailureBadge,
} from './tool-lane-format.js';
import { pushOutcomeRows } from './tool-lane-outcome-rows.js';
import { truncateDisplayWidth, displayWidth } from '../../display.js';
import { formatElapsed } from '../../terminal-compositor.scrollback.js';
import {
  renderOverlayChildren,
  type ToolEntry,
  type Entry,
} from './tool-lane-render.js';
import type { buildChildMap, getGlyphs } from './tool-lane-render.js';
import { formatFlatRootCompletion } from './tool-lane-overlay-completion.js';
import type { ToolLaneFlash } from './tool-lane-flash.js';
import type { ElementFade } from '../../smoke-fade.js';

// Local aliases for the return-type shapes used in helper signatures.
// `typeof` on a type-import is valid in TypeScript (erased at emit).
type ChildMap = ReturnType<typeof buildChildMap>;
type Glyphs = ReturnType<typeof getGlyphs>;
type ActiveTools = { activeCount: number; toolUseIds: Set<string>; toolIndex?: Map<string, number> } | null;

/**
 * Render a NESTING root that still has in-lane children (the common Agent/skill
 * path). Pushes the head row, the child block, and optionally a thinkingTail.
 *
 * Invariant: committed labels live in scrollback; live overlay may render
 * anonymous anchors only to preserve tree geometry.
 *
 * External constraint (append-only scrollback): once `flushSource` eagerly
 * emits an ancestor header to scrollback (marking `headerEmitted = true`),
 * the overlay must NOT redraw any label for that ancestor — the label is now
 * in scrollback, and any overlay-rendered re-statement of it reads as a
 * duplicate of the committed row.
 *
 * Anonymous-anchor invariant (headerEmitted branch, overlay path): when the
 * header is in scrollback but in-flight children remain, emit a row that
 * occupies the parent's column position but carries NO label and NO ↳
 * back-reference glyph. The row exists for geometry only — it gives the child
 * rows below a real visual row to point their `│ ├─` connectors at, so
 * descendants don't appear to float disconnected.
 *
 * At root depth the anchor is `palette.dim(g.turnRoot)` alone (`dim('◉  ')` /
 * `dim('o  ')`) — same 3-cell width as the live header's marker, anchoring the
 * spine column for child rows below. No label, no ↳ glyph.
 *
 * Both head branches use `clamp()` to bound the row to terminal cols.
 */
export function renderNestingWithChildren(
  entry: ToolEntry,
  children: Entry[],
  childMap: ChildMap,
  lines: string[],
  g: Glyphs,
  cols: number,
  fade: ElementFade | null,
): void {
  const clamp = (line: string): string => truncateDisplayWidth(line, cols);

  if (entry.headerEmitted) {
    // Anonymous anchor: marker only, no label body. The committed label lives
    // in scrollback above. Dim the marker — pure geometry, not identity.
    lines.push(clamp(palette.dimCompleted(g.turnRoot) + childFailureBadge(entry.failedChildCount)));
  } else if (entry.result) {
    // Completed nesting root whose children are still in the lane:
    // addResult() sets entry.result before the next overlay repaint, so a
    // completed parent must use dimCompleted — not activeAgent — to maintain
    // the active-vs-completed distinction.
    lines.push(clamp(palette.dimCompleted(g.turnRoot) + entry.prefix + childFailureBadge(entry.failedChildCount)));
  } else {
    // Active (in-flight) nesting root: use activeAgent for the ◉ marker so
    // the whole row is clearly readable. entry.prefix (agent name + args) is
    // already colorized by formatToolLine with color.bold(name).
    lines.push(clamp(palette.activeAgent(g.turnRoot) + entry.prefix + childFailureBadge(entry.failedChildCount)));
  }

  renderOverlayChildren(children, childMap, lines, cols, undefined, g, undefined, fade);

  // Render the thinking-tail AFTER the children so the subagent's in-flight
  // narration sits below its tool calls, not between the Agent prefix and its
  // first tool. Mirrors the text-child ordering in renderOverlayChildren /
  // renderFlushChildren.
  // Clamp: thinkingTail is unbounded narration; without clamp the terminal
  // hard-wraps to col 0 with no gutter, orphaning a flush-left continuation
  // between siblings.
  //
  // Invariant: prefix is `dim(g.spine) + '⌇  '` (6 cells) — col 0 carries the
  // Agent's live spine; `⌇` sits at col 3 (parallel to `├` / `╰` connector
  // positions in child rows above); two trailing pad cells (cols 4–5) land
  // tail content at col 6, aligned with the content column of the Agent's
  // tool children (`│  ╰─ <content>` also places content at col 6).
  if (entry.thinkingTail) {
    lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
  }
}

/**
 * Render a NESTING root that has no in-lane children (all flushed or not yet
 * spawned). Pushes a single head row plus an optional thinkingTail.
 *
 * Invariant: a NESTING dispatch head (skill/Agent/compose) anchors the
 * topology spine with the turn-root marker (g.turnRoot, ◉) at col 0 —
 * ALWAYS, even when it owns no in-lane children. This branch is the childless,
 * NOT-yet-committed case: the head's descendants were rooted separately or
 * already flushed to scrollback, leaving zero in-lane children. It is still a
 * dispatch head and must carry ◉ so child/sibling rows below have a real spine
 * column to attach to.
 *
 * Without this branch the entry falls through to the flat-leaf else below and
 * renders at a bare 2-space lead with no ◉ and no spine — a NESTING row
 * floating disconnected from the topology (the "broken spine / floating skill
 * row" bug). This mirrors flush()'s discriminant exactly: NESTING membership
 * alone routes to the frame head.
 *
 * The outcome (completed) or " …" (in-flight) is appended to the head row
 * since there are no child rows to carry it. A NESTING dispatch never carries
 * a `diff` payload (diffs originate from edit/write tool_diff chunks), so no
 * diff block is rendered here.
 *
 * Mirror the thinkingTail handling of the other NESTING branches: spine glyph
 * (g.spine, │) at col 0, ⌇ continuation glyph at col 3, so in-flight
 * narration aligns under the head row.
 */
export function renderNestingChildless(
  entry: ToolEntry,
  lines: string[],
  g: Glyphs,
  cols: number,
  activeTools: ActiveTools,
): void {
  const clamp = (line: string): string => truncateDisplayWidth(line, cols);

  if (entry.result) {
    // Completed nesting entry: dim the structural chrome — it is done.
    // pushOutcomeRows: status beats label on the head row; continuation rows
    // get the full row width.
    const head = {
      lead: palette.dimCompleted(g.turnRoot),
      label: entry.prefix,
      sep: palette.dimCompleted(' — ') + doneGlyph(entry.result.isError, entry.result.failureClass) + ' ',
      suffix: batchBadge(entry.result) + childFailureBadge(entry.failedChildCount),
    };
    pushOutcomeRows(lines, head, entry.result, {
      continuationIndent: palette.dimCompleted(g.spine) + '  ',
      cols,
      toolName: entry.toolName,
    });
  } else {
    // Active (in-flight) nesting entry: use activeAgent for ◉ so the agent
    // name row is clearly readable. The ' …' tail is structural/informational
    // — keep it dim so it recedes behind the agent identity.
    // Live elapsed counter: computed at repaint time so the counter ticks on
    // every overlay refresh without a dedicated timer. Grace period
    // (ELAPSED_GRACE_MS = 2s) suppresses the counter for fast tools.
    lines.push(
      clamp(
        palette.activeAgent(g.turnRoot) +
          entry.prefix +
          palette.dim(' …') +
          formatElapsed(entry.startedAt) +
          activeToolBadge(entry.toolUseId, activeTools) +
          childFailureBadge(entry.failedChildCount),
      ),
    );
  }

  if (entry.thinkingTail) {
    lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
  }
}

/**
 * Render a flat (non-NESTING) root entry. Pushes the outcome or in-flight row,
 * plus any diff / previewDiff / thinkingTail / outputTail lines.
 *
 * Invariant: col 0 carries `flatRootLeadActive` / `flatRootLeadDone` — 3 cells
 * wide — so the `●` glyph lands at the same column regardless of whether a
 * NESTING sibling is present. The lead is passed in by the caller because
 * it depends on the full `visibleRoots` set (hasNestingRoot), which is computed
 * once per frame by the orchestrating loop.
 */
export function renderFlatRoot(
  entry: ToolEntry,
  lines: string[],
  g: Glyphs,
  cols: number,
  flatRootLeadActive: string,
  flatRootLeadDone: string,
  activeTools: ActiveTools,
  flash: ToolLaneFlash | null,
): void {
  const clamp = (line: string): string => truncateDisplayWidth(line, cols);

  if (entry.result) {
    // Completed flat-root: render via toolCard (collapsed) so the badge, tool
    // name, elapsed, and batch badge share the component's layout contract.
    // The flatRootLeadDone is prepended by the caller so the lead stays
    // outside the component's width budget — subtract its display width from
    // the card's column budget to prevent overflow.
    // Use finishedAt (frozen at result-arrival time) so elapsed doesn't drift
    // on every repaint; fall back to Date.now() for entries that pre-date the
    // finishedAt field (should not occur in practice).
    const elapsedMs = (entry.finishedAt ?? Date.now()) - entry.startedAt;
    const cardWidth = cols - displayWidth(flatRootLeadDone);
    const card = formatFlatRootCompletion(entry.toolName, entry.result, elapsedMs, batchBadge(entry.result), cardWidth);
    // Flash pulse: bold-wrap the card for 150ms after completion so the glyph
    // catches the eye in peripheral vision (issue: lane-flash).
    const flashedCard = flash?.isFlashing(entry.toolUseId) ? palette.bold(card) : card;
    lines.push(clamp(flatRootLeadDone + flashedCard));
    if (entry.diff && !entry.result.isError) {
      // Diff hangs under the outcome line, indented one level deeper (4 spaces)
      // so it visually attaches to this tool entry.
      for (const line of formatDiffBlock(entry.diff, 'overlay', '    ')) {
        lines.push(clamp(line));
      }
    }
  } else {
    // Active flat-root: use flatRootLeadActive so the in-flight tool name is
    // clearly readable. The ' …' tail is structural — keep it dim.
    // Live elapsed counter: same pattern as the NESTING branch above —
    // computed at repaint time, suppressed under ELAPSED_GRACE_MS (2s).
    lines.push(
      clamp(flatRootLeadActive + entry.prefix + palette.dim(' …') + formatElapsed(entry.startedAt) + activeToolBadge(entry.toolUseId, activeTools)),
    );
    if (entry.previewDiff) {
      // Pre-execution diff preview: formatPreviewDiffBlock renders ⟳ Proposed
      // and applies the AFK_SHOW_DIFFS=0 opt-out (returns [] when disabled).
      for (const line of formatPreviewDiffBlock(entry.previewDiff, '    ', cols)) {
        lines.push(clamp(line));
      }
    }
    if (entry.thinkingTail) {
      // Childless Agent entries (a child just opened its thinking block and
      // hasn't yet emitted content or a tool_use) get the tail right under the
      // " …" line — exactly the position the eventual first child will occupy,
      // so adding/removing the tail doesn't make the overlay jump.
      // Prefix shape mirrors the NESTING_TOOLS branch: `dim(g.spine) + '⌇  '`
      // (6 cells) — col 0 = live spine, col 3 = `⌇` (connector slot), cols
      // 4–5 = pad, content at col 6. See the Invariant note at the
      // NESTING_TOOLS branch in tool-lane-overlay.ts for the column-alignment
      // rationale.
      lines.push(clamp(palette.dim(g.spine) + palette.thinking('⌇  ' + sanitizeLabel(entry.thinkingTail))));
    }
    if (entry.outputTail) {
      // Live bash output tail (issue #1506): last N lines of stdout/stderr,
      // rendered as dim italic continuation lines under the in-flight row.
      // Ephemeral overlay only — never reaches scrollback or the model.
      // Each tail line is indented 5 spaces to align with the tool content
      // column (matching the previewDiff/thinkingTail indent), clamped to the
      // terminal width to prevent soft-wrap from orphaning a flush-left
      // continuation between siblings.
      for (const tailLine of entry.outputTail.split('\n')) {
        if (tailLine.length > 0) {
          lines.push(clamp('     ' + palette.dim(sanitizeLabel(tailLine))));
        }
      }
    }
  }
}
