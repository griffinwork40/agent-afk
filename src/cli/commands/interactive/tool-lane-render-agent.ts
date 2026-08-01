import { palette } from '../../palette.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { formatToolCallStat } from '../../format-utils.js';
import { MAX_VISIBLE_CHILDREN, batchBadge } from './tool-lane-format.js';
import type { ToolEntry, Entry } from './tool-lane-render.js';
import { getGlyphs, clampLineToTerminal } from './tool-lane-render.js';
import { renderFlushChildren } from './tool-lane-render-children.js';

/**
 * Compose a NESTING root's committed-scrollback closer — the `Done (…)` line —
 * as a fully-styled string: the dimmed result-summary followed by the
 * concurrency-batch badge (` ∥i/N`) when the root ran in a parallel wave
 * (`agent.result.batchSize > 1`). Returns `undefined`/empty as-is for a falsy
 * summary so no phantom closer is synthesized (`addResultSummarySynthetic` skips
 * a falsy summary).
 *
 * Styling ownership (why this dims the base HERE): the render sites in
 * tool-lane-render-children.ts emit a `resultSummary` sibling's `.summary`
 * VERBATIM — they no longer wrap it in `palette.dim()`. A NESTING closer has two
 * differently-styled parts (a dim base + a self-dimmed badge from `batchBadge`),
 * so a single outer dim would nest the badge's own dim codes. Dimming the base
 * here and letting `batchBadge` self-dim keeps each part dimmed exactly once.
 * `summaryWithBatchBadge` is the SOLE feeder of `addResultSummarySynthetic` (via
 * renderFlushChildren), so the "summary is pre-styled" invariant holds for every
 * `resultSummary` item. For a non-parallel closer `batchBadge` returns `''`, so
 * the output is `palette.dim(summary)` — byte-identical to the prior behavior.
 *
 * Contract (issue #532 — scrollback NESTING-root badge): the closer, NOT the
 * head row, is the correct anchor for a NESTING root's badge in committed
 * scrollback:
 *  - A NESTING head row (`◉ → agent(…)`) carries NO outcome — the outcome lives
 *    on the `agentResultSummary` closer, so the closer is the nesting-root analog
 *    of a flat root's outcome row (where the badge already lives after #520).
 *  - The head row may be committed EAGERLY by {@link formatAgentHeader} (via
 *    flushSource's ancestor walk) BEFORE the root completes, when `batchSize` is
 *    not yet known; that path sets `headerEmitted=true` and routes the completion
 *    emit to {@link formatAgentChildren} (closer only, no head row). The closer is
 *    the one row emitted at completion time in BOTH the headerEmitted=false
 *    ({@link formatAgentSummary}) and headerEmitted=true ({@link formatAgentChildren})
 *    paths, and `agent.result.batchSize` is available at that point.
 *  - `batchBadge` returns `''` for singleton batches (batchSize<=1) and when
 *    `result` is absent, so a sequential dispatch is never badged (parity with
 *    flat roots / bash).
 *
 * The badge changes no indent, connector, or spine glyph — it is text appended
 * to the closer's content only, so the severed-spine dual-encoding invariant
 * between formatAgentHeader/formatAgentSummary is untouched.
 */
function summaryWithBatchBadge(agent: ToolEntry): string | undefined {
  return agent.agentResultSummary
    ? palette.dim(agent.agentResultSummary) + batchBadge(agent.result)
    : agent.agentResultSummary;
}

/**
 * Render an Agent (subagent) entry plus its tree of children as a scrollback
 * block.
 *
 * `extraDepth` shifts the entire block right by N additional spine columns
 * (2 cells per level — the same width as a depth-1 spine slot). Default 0
 * = root-level Agent rendering (one `◉ ` marker at col 0). Callers pass
 * `extraDepth > 0` when the Agent sits under a still-in-flight ancestor
 * (e.g. a `skill` parent that hasn't yet completed) so the committed
 * scrollback block visually aligns with the live overlay's nesting instead
 * of unparenting itself the moment it transitions to Done.
 *
 * Under the spine renderer, each unit of `extraDepth` becomes one live
 * `g.spine` slot prepended to every row of the rendered block — the
 * external ancestor's column continues through the descendant's lines so
 * the spine reads as one continuous topology even across commit boundaries.
 *
 * External constraint (pattern card: ordered sequences governed by
 * append-only scrollback): once a subagent's done-event commits its block to
 * scrollback, the indent of that block cannot be retroactively adjusted. The
 * depth MUST be resolved by the caller — by walking the `agentContext` chain
 * of surviving lane entries — at the moment of commit.
 */
function formatAgentSummary(
  agent: ToolEntry,
  children: Entry[],
  childMap: Map<string, Entry[]>,
  homeDir?: string,
  ancestorIsLast: readonly boolean[] = [],
): string {
  const g = getGlyphs();
  const toolChildren = children.filter((c): c is ToolEntry => c.kind === 'tool');
  const completed = toolChildren.filter((c) => c.result);
  const totalLines = completed.reduce((sum, c) => sum + (c.result!.lineCount ?? 0), 0);

  // Reads toolChildren.length — the tool-lane's own list of committed ToolEntry
  // children. Post-2c invariant: toolChildren.length === source.stats.toolUses
  // at flush time, because every tool_use_detail event both adds a ToolEntry and
  // increments source.stats.toolUses (both increment-only paths).
  const stats: string[] = [];
  if (toolChildren.length > MAX_VISIBLE_CHILDREN) {
    stats.push(formatToolCallStat(toolChildren.length));
    if (totalLines > 0) stats.push(`${totalLines} lines`);
  }

  // Invariant: the HEAD row keeps every ancestor column OPEN; only DESCENDANT
  // rows close a last-child ancestor's column.
  //
  // The Agent's head row gets the `◉ ` marker (2 cells, same width as a spine
  // slot). `ancestorPrefix` draws one OPEN `g.spine` (`│ `) per live ancestor
  // — UNCONDITIONALLY, regardless of last-ness — so the head row's incoming
  // spine stays connected to its still-in-flight parent above (PR #642
  // floating-spine invariant: a committed ancestor header must never float
  // disconnected from its children). This matches the live overlay, where an
  // agent's OWN row is `│ ╰─ …` (parent column open via the active spine).
  //
  // DESCENDANT rows, by contrast, must CLOSE the column of any ancestor that
  // is currently the last sibling at its level — the overlay draws `╰─` there
  // and closes the column to `g.spineClosed` (`  `) below it. `ancestorIsLast`
  // (resolved by the caller at commit time via `ToolLane.ancestorIsLastOf`)
  // carries that per-column last-ness into `renderFlushChildren`. Pre-fix this
  // was an all-`false` vector (open `│` everywhere), so committed descendant
  // rows showed an open `│` at a column the overlay had closed — the visible
  // "severed spine" seam (col-0 `│` continuing below a last-child connector).
  //
  // Pattern card alignment: ordered-sequences governed by append-only
  // scrollback — both depth and last-ness must be resolved at commit time.
  const ancestorPrefix = palette.dim(g.spine.repeat(ancestorIsLast.length));
  const externalAncestors: readonly boolean[] = ancestorIsLast;

  const head = palette.dim(g.turnRoot);
  // Invariant: ONE width read per render frame, shared by the head row below
  // and the recursive child frame. Two reads could straddle a resize and emit
  // a head row clamped to the old width above children clamped to the new one.
  const cols = getTerminalWidth();
  // Clamped for the same reason every child row is: a root nesting entry
  // arrives with an unbounded prefix (the root dispatch path passes no
  // maxWidth), and the stats tail adds ~28 columns on top — a depth-0 `agent`
  // frame with more than MAX_VISIBLE_CHILDREN children measures ~109 columns
  // in an 88-column terminal. Plain clamp, not the grouped path's suffix
  // reservation: identity leads the row and the stats tail is expendable,
  // matching how the live overlay clamps the same row.
  const agentLine = clampLineToTerminal(
    stats.length > 0
      ? ancestorPrefix + head + agent.prefix + palette.dim(' — ' + stats.join(' · '))
      : ancestorPrefix + head + agent.prefix,
    cols,
  );

  // Pass agentResultSummary into renderFlushChildren so it is added as a
  // synthetic sibling BEFORE assignConnectors runs — ensuring the Done line
  // receives the correct LAST connector (not a hardcoded '⎿', which was Bug #5).
  // Thread `g` so the head row and child rows share one glyph set, and `cols`
  // (read once above) so the head row and the recursive flush frame agree on
  // width. `externalAncestors` extends the spine column-set leftward by
  // `extraDepth` so descendant rows align under the head row's ancestor spines.
  const childLines = renderFlushChildren(
    children,
    childMap,
    homeDir,
    // #532: badge the closer (Done line) when this NESTING root ran in a
    // parallel wave. See summaryWithBatchBadge for why the closer, not the head.
    summaryWithBatchBadge(agent),
    cols,
    externalAncestors,
    g,
  );

  return [agentLine, ...childLines].join('\n');
}

/**
 * Emit only the single header line for a NESTING_TOOLS ancestor entry —
 * the spine-encoded head row — without any children, resultSummary, or
 * tree connectors below.
 *
 * Used by {@link ToolLane.flushSource} to eagerly anchor an ancestor's
 * frame header in append-only scrollback the moment its first child
 * subagent commits (done-event), so subsequent child completions and any
 * interleaved prose all land BELOW the ancestor's visual header instead
 * of visually floating above a deferred frame closer.
 *
 * Encoding constraint: this head row MUST match the head-row encoding in
 * {@link formatAgentSummary} (line 1: `ancestorPrefix + g.turnRoot +
 * agent.prefix`). Both functions may emit a head row for the SAME
 * ToolEntry across the lifetime of a session — flushSource emits it
 * eagerly via this function, then dispose-time flush() may emit it via
 * formatAgentSummary for an entry whose flushSource never ran. If the
 * two encodings diverge, the user sees a visible topology break: rows
 * committed by formatAgentHeader appear with naked space indent while
 * descendants below render with `│ │ ◉ ` spine columns, leaving the
 * outermost ancestor floating without a spine that connects to its
 * children.
 *
 * That shared encoding includes the terminal-width clamp: both paths clamp the
 * head row to `getTerminalWidth()`, so a row that overflows is elided
 * identically no matter which path committed it.
 *
 * Width invariant matches formatAgentSummary: `g.spine` is 2 cells,
 * `g.turnRoot` is 2 cells, so the total head-row indent is
 * `2 * (ancestorIsLast.length + 1)` cells before `agent.prefix` — exactly the
 * same column position renderFlushChildren expects for its child rows.
 *
 * `ancestorIsLast` mirrors the same parameter contract as
 * {@link formatAgentSummary}: each element represents whether the corresponding
 * ancestor level was the last child at that depth. The HEAD row always keeps
 * all ancestor columns OPEN (rendered as `g.spine`) regardless of the values
 * in `ancestorIsLast` — callers pass an all-false vector for live ancestors.
 */
function formatAgentHeader(agent: ToolEntry, ancestorIsLast: readonly boolean[] = []): string {
  const g = getGlyphs();
  const ancestorPrefix = palette.dim(g.spine.repeat(ancestorIsLast.length));
  const head = palette.dim(g.turnRoot);
  // The terminal-width clamp is part of the shared head-row encoding — see the
  // encoding constraint above. formatAgentSummary clamps its head row, so this
  // one must too, or the same entry committed through the two paths would
  // differ whenever the row exceeds the terminal width.
  return clampLineToTerminal(ancestorPrefix + head + agent.prefix, getTerminalWidth());
}

/**
 * Emit only the children portion of an Agent/skill/compose frame — the
 * tree-connected child rows and optional `agentResultSummary` closer —
 * without the header line. Used by {@link ToolLane.flush} when an
 * ancestor entry's header was already emitted eagerly (via
 * {@link ToolLane.flushSource} / {@link formatAgentHeader}) so that
 * dispose-time flush can commit the frame closer without duplicating the
 * header that is already in scrollback.
 *
 * Callers must pass `ancestorIsLast` equal to the vector used when the header
 * was eagerly emitted so the tree connectors align with it. The header itself
 * (via {@link formatAgentHeader}) keeps its ancestor columns OPEN; these child
 * rows close any last-child ancestor column — see {@link formatAgentSummary}.
 */
function formatAgentChildren(
  agent: ToolEntry,
  children: Entry[],
  childMap: Map<string, Entry[]>,
  homeDir?: string,
  ancestorIsLast: readonly boolean[] = [],
): string[] {
  // Mirror formatAgentSummary's DESCENDANT-row encoding: thread the per-column
  // last-ness vector into renderFlushChildren so each ancestor column draws an
  // open `g.spine` (`│ `) when that ancestor is NOT its level's last sibling,
  // and a closed `g.spineClosed` (`  `) when it IS — matching the live overlay
  // (which closes a `╰─`'d ancestor's column below it). Pre-fix this was an
  // all-`false` vector (open `│` everywhere), diverging from the overlay on
  // committed scrollback descendant rows (the severed-spine seam). The header
  // row was emitted separately by formatAgentHeader with its columns OPEN, so
  // the eagerly-committed ancestor stays connected to its children (Bug B /
  // PR #642). `getGlyphs()` is read once so the block shares one glyph set.
  const g = getGlyphs();
  const externalAncestors: readonly boolean[] = ancestorIsLast;
  return renderFlushChildren(
    children,
    childMap,
    homeDir,
    // #532: badge the closer (Done line) when this NESTING root ran in a
    // parallel wave. In this (headerEmitted) path the head row was already
    // committed eagerly by formatAgentHeader without the badge (batchSize was
    // unknown then), so the closer is the only completion-time anchor.
    summaryWithBatchBadge(agent),
    getTerminalWidth(),
    externalAncestors,
    g,
  );
}


export { formatAgentSummary, formatAgentHeader, formatAgentChildren };
