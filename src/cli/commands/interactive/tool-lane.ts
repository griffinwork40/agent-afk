import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import { palette } from '../../palette.js';
import { SUBAGENT_TOOLS, NESTING_TOOLS } from '../../tool-category.js';
import { formatToolLine, formatToolResultLine, formatOutcome, formatDiffBlock, doneGlyph, sanitizeLabel } from './tool-lane-format.js';
import type { DiffPayload } from '../../../utils/diff.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { truncateDisplayWidth, stripAnsi } from '../../display.js';
import {
  renderOverlayChildren,
  formatAgentSummary,
  formatAgentHeader,
  formatAgentChildren,
  renderGroupedRootTools,
  getGlyphs,
  type ToolEntry,
  type TextEntry,
  type Entry,
} from './tool-lane-render.js';

// Re-export types from render module for consumers
export type { ToolEntry, TextEntry, Entry };

/**
 * Maximum number of root-level tool entries to render in the live overlay.
 * Long multi-tool turns (e.g. 14 tool calls over 2 minutes) otherwise
 * accumulate a row per tool, filling the screen. When the count exceeds
 * this cap, {@link ToolLane.getOverlay} elides the oldest *completed* root
 * entries — in-progress entries are always shown so the user can see what's
 * currently running. Scrollback (via {@link ToolLane.flush}) is unaffected.
 */
export const MAX_OVERLAY_ROOTS = 6;

/**
 * Buffers tool-use starts and results during execution, renders them as an
 * ephemeral overlay, and flushes a grouped compact summary to scrollback.
 * Mirrors ThinkingLane: overlay shows live detail, scrollback gets headlines.
 *
 * Also stores subagent text-content children (kind: 'text') under their
 * synthetic Agent parent; the streaming renderer drives these via
 * {@link upsertTextChild} and {@link removeTextChildrenUnder} so a subagent's
 * narration renders nested under its Agent entry alongside its tool calls.
 */
export class ToolLane {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private agentIdStack: string[] = [];

  addStart(toolUseId: string, toolName: string, toolInput: string): void {
    // Strip ANSI from toolInput at storage time: it originates from LLM
    // tool_use blocks and can carry OSC/CSI escapes that would render
    // verbatim through palette.dim() on breadcrumb paths (see
    // tool-lane-render.ts renderOverlayChildren and getOverlay below).
    // Stripping once at storage covers every downstream surface.
    const safeInput = stripAnsi(toolInput);
    const prefix = formatToolLine(toolName + safeInput);
    const agentContext = this.agentIdStack.at(-1) ?? undefined;
    const entry: ToolEntry = {
      kind: 'tool',
      toolUseId,
      toolName,
      toolInput: safeInput,
      prefix,
      ...(agentContext !== undefined ? { agentContext } : {}),
    };
    this.entries.set(toolUseId, entry);
    this.order.push(toolUseId);
    if (SUBAGENT_TOOLS.has(toolName)) {
      this.agentIdStack.push(toolUseId);
    }
  }

  /**
   * Like {@link addStart} but the caller specifies `agentContext` directly
   * instead of consulting the FIFO `agentIdStack`. Used by the skill-streaming
   * renderer to nest sub-agent tool calls under their synthesized
   * `Agent(...)` parent — stack-based nesting can't disambiguate "which agent
   * does this child belong to?" when multiple agents are active simultaneously.
   *
   * Does NOT push onto `agentIdStack`. Mixing this method with `addStart`
   * inside the same parent context is supported — the stack-based path
   * remains the natural way to track sequential nesting (the main turn
   * handler), while explicit-context is the natural way to track
   * concurrent fan-out.
   */
  addStartWithAgentContext(
    toolUseId: string,
    toolName: string,
    toolInput: string,
    agentContext: string | undefined,
    maxWidth?: number,
  ): void {
    // Same rationale as addStart: strip ANSI at storage time so LLM-emitted
    // escapes can't reach palette.dim() on any downstream render surface.
    const safeInput = stripAnsi(toolInput);
    const existing = this.entries.get(toolUseId);
    if (existing?.kind === 'tool') {
      existing.toolInput = safeInput;             // stripped, untruncated — preserved for flush()
      existing.prefix = formatToolLine(toolName + safeInput, maxWidth);  // truncated prefix for overlay
      if (agentContext !== undefined) existing.agentContext = agentContext;
      return;
    }
    const prefix = formatToolLine(toolName + safeInput, maxWidth);
    const entry: ToolEntry = {
      kind: 'tool',
      toolUseId,
      toolName,
      toolInput: safeInput,
      prefix,
      ...(agentContext !== undefined ? { agentContext } : {}),
    };
    this.entries.set(toolUseId, entry);
    this.order.push(toolUseId);
  }

  /**
   * Mutate an existing `agent`/`Task` ToolEntry to display as `Agent(<label>)`.
   * Returns `true` if the entry was found, is a tool entry, belongs to
   * SUBAGENT_TOOLS, and has NOT already been merged (toolName !== 'Agent').
   * Returns `false` otherwise. Callers use the return value as a merge-happened
   * guard to decide whether to create a synthetic child entry.
   *
   * Invariants: toolUseId key, agentContext, and agentIdStack are all
   * unchanged. Only toolName, toolInput, and prefix are mutated.
   */
  mergeAgentLabel(parentToolUseId: string, label: string, maxWidth?: number): boolean {
    const entry = this.entries.get(parentToolUseId);
    if (entry?.kind !== 'tool') return false;
    if (!SUBAGENT_TOOLS.has(entry.toolName)) return false;
    if (entry.toolName === 'Agent') return false; // already merged — prevent grandchild overwrite
    // Same rationale as addStart / addStartWithAgentContext: strip ANSI at
    // storage time so LLM-emitted escapes in the subagent label can't reach
    // palette.dim() on any downstream render surface (overlay or flush).
    const safeLabel = stripAnsi(label);
    const input = `(${safeLabel})`;
    entry.toolName = 'Agent';
    entry.toolInput = input;
    entry.prefix = formatToolLine('Agent' + input, maxWidth);
    return true;
  }

  /**
   * Update an existing tool entry's `agentContext`. No-op if the entry
   * doesn't exist or is a text entry.
   */
  setAgentContext(toolUseId: string, agentContext: string | undefined): void {
    const entry = this.entries.get(toolUseId);
    if (entry?.kind === 'tool') {
      if (agentContext === undefined) {
        delete entry.agentContext;
      } else {
        entry.agentContext = agentContext;
      }
    }
  }

  /**
   * Attach a summary line to an `Agent` (tool) entry, rendered after its
   * children by {@link ToolLane.flush}. Used by the streaming renderer to
   * surface a `Done (...)` line on synthesized concurrent-mode Agent entries.
   * No-op if the entry doesn't exist or is a text entry.
   */
  setAgentResultSummary(toolUseId: string, summary: string): void {
    const entry = this.entries.get(toolUseId);
    if (entry?.kind === 'tool') entry.agentResultSummary = summary;
  }

  /**
   * Set (or clear with `undefined`) the in-place thinking tail on an entry.
   * Rendered as a dim italic continuation line under the entry's prefix in
   * the live overlay only — never in {@link ToolLane.flush}, since scrollback
   * is post-mortem and the thinking summary belongs in `agentResultSummary`.
   * No-op if the entry doesn't exist or is a text entry.
   */
  setThinkingTail(toolUseId: string, tail: string | undefined): void {
    const entry = this.entries.get(toolUseId);
    if (entry?.kind !== 'tool') return;
    if (tail === undefined) {
      delete entry.thinkingTail;
    } else {
      entry.thinkingTail = tail;
    }
  }

  addResult(toolUseId: string, chunk: ToolResultChunk): void {
    const entry = this.entries.get(toolUseId);
    if (entry?.kind === 'tool') entry.result = chunk;
    if (this.agentIdStack.at(-1) === toolUseId) {
      this.agentIdStack.pop();
    }
  }

  /**
   * Attach a render-only diff payload to an existing tool entry. Called by
   * the streaming consumer when a `tool_diff` chunk arrives — sidecar to
   * the preceding `tool_result` chunk, keyed by `toolUseId`. No-op if the
   * entry doesn't exist (event arrived after the lane flushed) or is a
   * text entry (defensive — diffs only apply to tool entries).
   */
  addDiff(toolUseId: string, diff: DiffPayload): void {
    const entry = this.entries.get(toolUseId);
    if (entry?.kind === 'tool') entry.diff = diff;
  }

  /**
   * Create or replace the `text` of a {@link TextEntry} child. Used by the
   * streaming renderer to drive a subagent's live narration under its
   * synthetic Agent entry — each content delta calls this with the
   * accumulated text buffer.
   */
  upsertTextChild(toolUseId: string, agentContext: string, text: string): void {
    const existing = this.entries.get(toolUseId);
    if (existing?.kind === 'text') {
      existing.text = text;
      existing.agentContext = agentContext;
      return;
    }
    const entry: TextEntry = { kind: 'text', toolUseId, text, agentContext };
    this.entries.set(toolUseId, entry);
    this.order.push(toolUseId);
  }

  /**
   * Remove every {@link TextEntry} whose `agentContext` equals the given
   * parent id. Used by the streaming renderer to enforce "last block wins"
   * — when a new subagent text block starts (after a `tool_use_detail`
   * interrupt), any prior text under the same Agent is dropped.
   */
  removeTextChildrenUnder(agentContext: string): void {
    const toRemove: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.kind === 'text' && entry.agentContext === agentContext) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.entries.delete(id);
    }
    if (toRemove.length > 0) {
      const removed = new Set(toRemove);
      this.order = this.order.filter((id) => !removed.has(id));
    }
  }

  hasPending(): boolean {
    return this.entries.size > 0;
  }

  /**
   * Returns `true` if `id` is registered as a `tool` entry (not a text entry).
   * Used by the streaming renderer to distinguish a registered tool_use_id
   * (a valid nesting parent — e.g. a compose entry) from an arbitrary
   * session UUID that happens to be set as `meta.parentId` on regular
   * subagents. Without this gate, the parentId-as-tool-use-id fallback
   * orphans Agent entries by setting `agentContext` to an unregistered key.
   */
  hasEntry(id: string): boolean {
    const entry = this.entries.get(id);
    return entry?.kind === 'tool';
  }

  getOverlay(): string {
    const childMap = this.buildChildMap();
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
    const cols = getTerminalWidth();
    const clamp = (line: string): string => truncateDisplayWidth(line, cols);

    // Collect root-level tool entries (those rendered at the top of the
    // overlay), then apply the MAX_OVERLAY_ROOTS sliding-window cap. The cap
    // protects long multi-tool turns from filling the screen with completed
    // rows. Active (no-result) roots are *always* kept so the user can see
    // what is currently running — only the oldest *completed* roots are
    // elided, summarized via a trailing "… +N done" line.
    const rootEntries: ToolEntry[] = [];
    for (const id of this.order) {
      const entry = this.entries.get(id);
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
          lines.push(clamp(palette.dim(g.turnRoot) + entry.prefix + palette.dim(' — ') + doneGlyph(entry.result.isError) + ' ' + formatOutcome(entry.result, undefined, 60, entry.toolName)));
        } else {
          lines.push(clamp(palette.dim(g.turnRoot) + entry.prefix + palette.dim(' …')));
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
          lines.push(clamp('  ' + entry.prefix + palette.dim(' — ') + doneGlyph(entry.result.isError) + ' ' + formatOutcome(entry.result, undefined, 60, entry.toolName)));
          if (entry.diff && !entry.result.isError) {
            // Diff hangs under the outcome line, indented one level deeper
            // (4 spaces) so it visually attaches to this tool entry.
            for (const line of formatDiffBlock(entry.diff, 'overlay', '    ')) {
              lines.push(clamp(line));
            }
          }
        } else {
          lines.push(clamp('  ' + entry.prefix + palette.dim(' …')));
          if (entry.thinkingTail) {
            // Childless Agent entries (a child just opened its thinking block
            // and hasn't yet emitted content or a tool_use) get the tail right
            // under the " …" line — exactly the position the eventual first
            // child will occupy, so adding/removing the tail doesn't make the
            // overlay jump. Prefix shape mirrors the NESTING_TOOLS branch:
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

  /**
   * Walk the `agentContext` chain upward from `id`, counting how many ancestor
   * tool entries are still alive in the lane. Returns 0 for entries at root
   * (no agentContext) or whose ancestor chain leads to a missing entry.
   *
   * Used by {@link flushSource} to compute the indent depth at which a
   * subagent's committed scrollback block should land, so it visually nests
   * under its still-in-flight ancestor (e.g. a `skill` parent that hasn't
   * yet completed) instead of unparenting itself on the Done transition.
   *
   * Defensive cycle guard: caps the walk at a generous depth so a corrupted
   * graph can't spin forever. In normal operation depth is bounded by
   * MAX_NESTING_DEPTH (currently small single-digit), well under the cap.
   */
  private ancestorDepthOf(id: string): number {
    const seen = new Set<string>([id]);
    let depth = 0;
    let current: string | undefined = id;
    // Hard cap: depth above this means something is wrong (cycle, leak).
    // Better to under-indent than spin.
    const CYCLE_CAP = 32;
    while (current !== undefined && depth < CYCLE_CAP) {
      const entry = this.entries.get(current);
      if (!entry || entry.kind !== 'tool') break;
      const parent = entry.agentContext;
      if (parent === undefined) break;
      if (seen.has(parent)) break; // cycle — bail
      seen.add(parent);
      // Only count an ancestor toward depth if it is still a live tool entry
      // in the lane. A dangling agentContext (parent already flushed or never
      // registered) means the current entry effectively renders at root.
      const parentEntry = this.entries.get(parent);
      if (!parentEntry || parentEntry.kind !== 'tool') break;
      depth += 1;
      current = parent;
    }
    return depth;
  }

  /**
   * Flush only the entries belonging to a single source — identified by
   * `parentId` (the synthetic Agent tool-use ID). Collects the parent entry
   * and all descendants (children + grandchildren via `agentContext`), removes
   * them from the lane, and renders via {@link formatAgentSummary}.
   *
   * Other sources' entries remain in the lane and continue to render in the
   * live overlay. Used by the subagent done-event path so parallel sub-agents
   * don't steal each other's entries.
   *
   * Nesting preservation: if the targeted source has surviving in-lane
   * ancestors (e.g. a `skill` parent that hasn't yet completed), the flushed
   * block is indented `ancestorDepthOf(parentId)` levels deeper than root so
   * the committed scrollback visually aligns with the live overlay's nesting.
   * Without this, a subagent that finishes inside a still-running skill would
   * commit at the root indent and visually "escape" its parent — a classic
   * unparenting bug. See pattern card on ordered-sequences governed by
   * append-only scrollback: indent must be resolved at commit time, never
   * after.
   *
   * Eager ancestor-header emission: before committing the child's block,
   * walks the ancestor chain (outermost first) and emits the header line for
   * any ancestor that has not yet been committed to scrollback
   * (entry.headerEmitted !== true). Each emitted header is marked
   * `headerEmitted = true` so subsequent sibling `flushSource` calls and
   * the dispose-time `flush()` do NOT re-emit it. This ensures the
   * ancestor's visual frame header always appears ABOVE its first child in
   * append-only scrollback, regardless of when the ancestor resolves.
   */
  flushSource(parentId: string, homeDir?: string): string[] {
    const parentEntry = this.entries.get(parentId);
    if (!parentEntry || parentEntry.kind !== 'tool') return [];

    // Resolve the in-lane ancestor depth BEFORE we delete any entries —
    // the walk depends on the parent (skill, compose, etc.) still being
    // present in `this.entries`. Capturing it post-delete would always return
    // 0 (the parent's agentContext would still be set but the lookup-by-id
    // would miss the now-deleted ancestor, falsely flattening the indent).
    //
    // Invariant: in the flushSource path the ancestor (skill/compose) is BY
    // DEFINITION still live — it survives this flush as an ancestor of the
    // target. A live ancestor's last-child is therefore UNKNOWABLE at commit
    // time: it may spawn another wave, or its last-INSERTED child may complete
    // first. Committing a CLOSED (`  `) ancestor column into append-only
    // scrollback bakes a guess that the live overlay (and the ancestor's own
    // later closer / next-wave anchor) then contradicts — re-opening col-0
    // below the closed rows and severing the spine (the "fragmentation" the
    // prior ancestorIsLastOf approach produced). So every live-ancestor column
    // stays OPEN here; the column only legitimately closes when the ancestor
    // itself settles, which the dispose-time flush() path handles via the
    // normal recursive connector assignment (it already passes []).
    const ancestorIsLast: readonly boolean[] = Array.from(
      { length: this.ancestorDepthOf(parentId) },
      () => false,
    );

    // ── Eager ancestor-header emission ────────────────────────────────────
    //
    // Walk from parentId upward through agentContext links, collecting all
    // live ancestor entries. Emit header lines for those whose header has
    // not yet been committed (headerEmitted !== true), outermost first.
    // Mark each emitted ancestor with headerEmitted = true so sibling
    // flushSource calls and dispose-time flush() do not re-emit them.
    //
    // The chain is collected child→parent, then reversed to emit outermost-
    // first (so the outermost frame header always precedes its descendants
    // in scrollback, matching natural reading order).
    const ancestorLines: string[] = [];
    {
      const chain: Array<{ entry: ToolEntry; depth: number }> = [];
      const seen = new Set<string>([parentId]);
      let cur: string | undefined = parentEntry.agentContext;
      while (cur !== undefined) {
        if (seen.has(cur)) break;           // cycle guard
        seen.add(cur);
        const anc = this.entries.get(cur);
        if (!anc || anc.kind !== 'tool') break; // missing or text entry
        chain.push({ entry: anc, depth: this.ancestorDepthOf(anc.toolUseId) });
        cur = anc.agentContext;
      }
      // Reverse to get outermost ancestor first.
      chain.reverse();
      for (const { entry: anc, depth } of chain) {
        if (anc.headerEmitted) continue;   // already in scrollback — skip
        ancestorLines.push(formatAgentHeader(anc, Array.from({ length: depth }, () => false)));
        anc.headerEmitted = true;
      }
    }

    // Collect all descendants: walk the agentContext tree breadth-first.
    const collected = new Set<string>([parentId]);
    const queue = [parentId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [id, entry] of this.entries) {
        if (collected.has(id)) continue;
        const ctx = entry.kind === 'tool' ? entry.agentContext : entry.agentContext;
        if (ctx === current) {
          collected.add(id);
          if (entry.kind === 'tool') queue.push(id);
        }
      }
    }

    // Build a child map scoped to collected entries only.
    const childMap = new Map<string, Entry[]>();
    for (const id of this.order) {
      if (!collected.has(id)) continue;
      const entry = this.entries.get(id);
      if (!entry) continue;
      const ctx = entry.kind === 'tool' ? entry.agentContext : entry.agentContext;
      if (!ctx) continue;
      let children = childMap.get(ctx);
      if (!children) {
        children = [];
        childMap.set(ctx, children);
      }
      children.push(entry);
    }

    // Render via the same path as flush(), shifted by the ancestor depth so
    // nested completes don't visually escape their still-in-flight parent.
    //
    // External constraint (append-only scrollback, mirror of flush()'s
    // headerEmitted guard at line ~540): if parentEntry itself was already
    // promoted to headerEmitted by an earlier sibling's flushSource (e.g.
    // paranoid completes first, walks up the chain marking devils-advocate
    // headerEmitted=true; pragmatist completes second and is the next
    // flushSource target — its parentEntry chain stops at devils-advocate
    // which is already in scrollback), emit ONLY the children + closer via
    // `formatAgentChildren`, NOT the full block with re-emitted header.
    // Without this guard, formatAgentSummary unconditionally re-emits the
    // header line and a duplicate appears under the eagerly-committed copy.
    //
    // Note: this guard targets a different case from the ancestor-walk above
    // (which handles ancestors OF parentEntry). Here we're handling
    // parentEntry itself being headerEmitted — possible when parentEntry is
    // a NESTING_TOOL ancestor whose own descendant earlier triggered an
    // eager emission that included parentEntry, and now parentEntry itself
    // is completing (e.g., devils-advocate finishes after all its children).
    const children = childMap.get(parentEntry.toolUseId) ?? [];
    const childBlock = parentEntry.headerEmitted
      ? formatAgentChildren(parentEntry, children, childMap, homeDir, ancestorIsLast).join('\n')
      : formatAgentSummary(parentEntry, children, childMap, homeDir, ancestorIsLast);

    // Remove collected entries from the lane.
    for (const id of collected) {
      this.entries.delete(id);
    }
    this.order = this.order.filter((id) => !collected.has(id));

    // Return ancestor header lines (outermost first) followed by the child
    // block. The caller iterates with `compositor.commitAbove(line)` for
    // each element, so ancestor headers land in scrollback before the child.
    //
    // When parentEntry was headerEmitted and had no children + no closer to
    // render, `formatAgentChildren` returns []; the joined empty string is
    // skipped so we don't push a blank line to scrollback.
    const blockLines = childBlock === '' ? [] : [childBlock];
    return [...ancestorLines, ...blockLines];
  }

  /**
   * Selective sibling of {@link flush}: commit ONLY root entries whose
   * dispatch has resolved (entry.result !== undefined), leaving in-flight
   * roots (and their descendants) in the lane for future calls.
   *
   * Used by {@link flushToolLaneToScrollback} on every orchestrator content
   * chunk — the previous behavior (`flush()` nuking everything) was
   * destroying still-running subagent rows when the orchestrator emitted
   * prose interleaved with subagent dispatches. With selective removal,
   * completed roots commit to scrollback in causal order while live
   * subagent rows survive in the overlay.
   *
   * Semantics:
   *   - Rendering reuses the same path as {@link flush} (renderGroupedRootTools
   *     for leaf-tool roots, formatAgentSummary / formatAgentChildren for
   *     NESTING_TOOL roots — including the headerEmitted=true closer-only
   *     branch). A completed NESTING_TOOL root's still-in-lane children are
   *     rendered as part of its block (same as flush()).
   *   - Removal is BFS-scoped to the flushed roots: each completed root and
   *     every descendant of it (walked via agentContext) are deleted; other
   *     entries are untouched.
   *   - {@link agentIdStack} is left intact. Completed dispatch tools have
   *     already been popped at addResult time (tool-lane.ts:174); in-flight
   *     ones must remain so subsequent addStart calls inherit the right
   *     agentContext. Filtering would be a no-op in practice — defensive
   *     and unnecessary.
   *
   * @returns rendered lines for the caller to commit to scrollback. Empty
   *   when no roots have completed yet — the caller should skip the gap +
   *   scrollback writes in that case but should still refresh the overlay
   *   to {@link getOverlay} so in-flight rows persist visually.
   */
  flushCompletedRoots(homeDir?: string): string[] {
    if (this.entries.size === 0) return [];

    const childMap = this.buildChildMap();
    const rootOrder: string[] = [];

    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (!entry || entry.kind !== 'tool') continue;
      if (entry.agentContext) continue;          // not a root
      if (entry.result === undefined) continue;  // in-flight — keep in lane
      rootOrder.push(id);
    }

    if (rootOrder.length === 0) return [];

    // Render exactly as flush() does for these roots. Code is duplicated
    // (not extracted) because the bodies diverge on the removal step at
    // the end — flush() nukes everything, flushCompletedRoots() removes
    // only collected IDs. Extracting would require threading a "what to
    // collect" predicate that obscures the intent at the call sites.
    const lines: string[] = [];
    const groups = new Map<string, ToolEntry[]>();
    const groupOrder: string[] = [];

    for (const id of rootOrder) {
      const entry = this.entries.get(id);
      if (!entry || entry.kind !== 'tool') continue;
      const children = childMap.get(entry.toolUseId);

      if (NESTING_TOOLS.has(entry.toolName)) {
        lines.push(...renderGroupedRootTools(groups, groupOrder, homeDir));
        groups.clear();
        groupOrder.length = 0;
        if (entry.headerEmitted) {
          const closerLines = formatAgentChildren(entry, children ?? [], childMap, homeDir, []);
          lines.push(...closerLines);
        } else {
          lines.push(formatAgentSummary(entry, children ?? [], childMap, homeDir));
        }
      } else {
        if (!groups.has(entry.toolName)) {
          groups.set(entry.toolName, []);
          groupOrder.push(entry.toolName);
        }
        groups.get(entry.toolName)!.push(entry);
      }
    }

    lines.push(...renderGroupedRootTools(groups, groupOrder, homeDir));

    // BFS-collect each flushed root + its descendants (same traversal as
    // flushSource at tool-lane.ts:467-479). Only collected IDs are removed;
    // in-flight roots and their subtrees remain untouched in the lane.
    const collected = new Set<string>(rootOrder);
    const queue = [...rootOrder];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [id, entry] of this.entries) {
        if (collected.has(id)) continue;
        const ctx = entry.kind === 'tool' ? entry.agentContext : entry.agentContext;
        if (ctx === current) {
          collected.add(id);
          if (entry.kind === 'tool') queue.push(id);
        }
      }
    }

    for (const id of collected) {
      this.entries.delete(id);
    }
    this.order = this.order.filter((id) => !collected.has(id));

    return lines;
  }

  flush(homeDir?: string): string[] {
    if (this.entries.size === 0) return [];

    const childMap = this.buildChildMap();
    const rootOrder: string[] = [];

    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (!entry || entry.kind !== 'tool') continue;
      if (!entry.agentContext) rootOrder.push(id);
    }

    const lines: string[] = [];
    const groups = new Map<string, ToolEntry[]>();
    const groupOrder: string[] = [];

    for (const id of rootOrder) {
      const entry = this.entries.get(id);
      if (!entry || entry.kind !== 'tool') continue;
      const children = childMap.get(entry.toolUseId);

      // History: `children.length > 0` was a co-discriminant alongside NESTING_TOOLS
      //   membership. Symptom: a skill/agent whose children all flushed mid-turn (via
      //   flushSource) fell through to renderGroupedRootTools and rendered as a flat
      //   leaf BELOW its own already-committed children — visually ejecting them from
      //   the skill frame. Fix: membership alone is the discriminant; formatAgentSummary
      //   emits header + agentResultSummary correctly even with an empty child list.
      //   Pattern card: ordered-sequences-governed-by-append-only-scrollback (indent
      //   and frame must be resolved at commit time, never after).
      //
      // Invariant: when {@link flushSource} has already emitted this entry's header
      //   (entry.headerEmitted === true), route to {@link formatAgentChildren}
      //   (children + agentResultSummary, no header) — formatAgentSummary would
      //   re-emit the header and duplicate it in scrollback.
      if (NESTING_TOOLS.has(entry.toolName)) {
        lines.push(...renderGroupedRootTools(groups, groupOrder, homeDir));
        groups.clear();
        groupOrder.length = 0;
        if (entry.headerEmitted) {
          // Header already in scrollback from flushSource; emit only closer.
          const closerLines = formatAgentChildren(entry, children ?? [], childMap, homeDir, []);
          lines.push(...closerLines);
        } else {
          lines.push(formatAgentSummary(entry, children ?? [], childMap, homeDir));
        }
      } else {
        if (!groups.has(entry.toolName)) {
          groups.set(entry.toolName, []);
          groupOrder.push(entry.toolName);
        }
        groups.get(entry.toolName)!.push(entry);
      }
    }

    lines.push(...renderGroupedRootTools(groups, groupOrder, homeDir));

    this.entries.clear();
    this.order = [];
    this.agentIdStack = [];
    return lines;
  }

  private buildChildMap(): Map<string, Entry[]> {
    const map = new Map<string, Entry[]>();
    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const ctx = entry.kind === 'tool' ? entry.agentContext : entry.agentContext;
      if (!ctx) continue;
      let children = map.get(ctx);
      if (!children) {
        children = [];
        map.set(ctx, children);
      }
      children.push(entry);
    }
    return map;
  }
}

// Re-export public formatting functions
export { formatToolLine, formatToolResultLine };
