import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import type { DiffPayload } from '../../../utils/diff.js';
import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { wrapToWidth } from '../../wrap.js';
import { truncateDisplayWidth } from '../../display.js';
import { capToMeasure } from '../../render/measure.js';
import { sanitizeTextParagraph } from './tool-lane-format.js';
// Re-export so tool-lane.ts can reach formatElapsed via the already-imported
// render module — avoids an extra import line in the ratchet-capped file.
export { formatElapsed } from '../../terminal-compositor.scrollback.js';

/**
 * Clamp a composed tree-render line to the terminal's current width.
 *
 * Tree-children lines are composed from multiple segments — indent +
 * tree connector (`├ ` / `└ `) + tool prefix + ` — ✓ ` + outcome preview.
 * Only the *prefix* segment is width-budgeted upstream (in
 * `stream-renderer-subagent.ts`, `cols - 14`); the trailing ` — outcome`
 * (up to ~70 chars with a 60-char preview) is appended unbudgeted. When
 * the composed line exceeds terminal width the terminal hard-wraps the
 * overflow to column 0 with no tree connector, visually splitting the
 * tree and orphaning a flush-left raw-text continuation between siblings.
 *
 * `truncateDisplayWidth` is ANSI-aware (preserves color codes and resets)
 * and grapheme-correct. Truncation prefers eliding the *tail* of the
 * outcome preview over the more-informative prefix, which is the right
 * trade-off: the prefix carries tool name + args, the outcome tail is
 * typically just the end of a snippet.
 */
export function clampLineToTerminal(line: string, cols: number): string {
  return truncateDisplayWidth(line, cols);
}

/**
 * Invariant: every composed tool-lane row shares ONE width budget, and that
 * budget is the shared reading measure — not the raw terminal width.
 *
 * The budget is load-bearing twice over, which is why it has a name instead of
 * being inlined at each call site:
 *
 *  1. Wrap prevention. A composed row that exceeds the terminal hard-wraps to
 *     column 0 with no spine glyph, splitting the tree (see
 *     {@link clampLineToTerminal}). Every row must be clamped to at most the
 *     terminal width.
 *  2. Reading measure. `renderTextChildLines` below already caps wrapped
 *     tool-lane *text* at the shared measure, and prose, thinking, and
 *     subagent text do the same (see `render/measure.ts`). Composed tool rows
 *     did not, so on a terminal wider than the measure the lane's own text
 *     stopped at one column while its tool rows ran to the screen edge —
 *     exactly the "adjacent unbordered blocks stop at different columns"
 *     discontinuity the measure invariant exists to prevent.
 *
 * `capToMeasure` is a pure `min`, never a widen, so (2) strictly strengthens
 * (1): the wrap guarantee still holds, and on terminals at or below the
 * measure this is a no-op. Callers that must agree on a width (the
 * `formatAgentSummary` / `formatAgentHeader` head-row encoding pair) agree by
 * calling this, not by both happening to read the terminal.
 */
export function toolLaneWidth(): number {
  return capToMeasure(getTerminalWidth());
}

interface ToolEntryFields {
  toolUseId: string;
  toolName: string;
  toolInput: string;
  prefix: string;
  result?: ToolResultChunk;
  agentContext?: string;
  /**
   * Optional summary line appended after the children of an `Agent` entry
   * during {@link ToolLane.flush}. Used by the streaming renderer to attach
   * a `Done (N tools · M tok · Xs)` line to synthesized concurrent-mode
   * Agent entries. No effect on non-Agent entries or when unset.
   */
  agentResultSummary?: string;
  /**
   * Optional in-place "thinking…" tail rendered as a dim italic line right
   * under this entry's prefix in the live overlay only. Used by the streaming
   * renderer's subagent path to show the last clause of in-flight extended
   * thinking under a synthetic `Agent(...)` entry while the child is still in
   * its thinking block. Cleared on the next content / tool_use / done event
   * for the source. Never appears in scrollback (flush()) — the post-mortem
   * channel is `agentResultSummary`'s "thought Xs · N tok" annotation.
   */
  thinkingTail?: string;
  /**
   * Optional render-only diff payload attached by the streaming consumer
   * after a `tool_diff` chunk arrives. Set late (after the result), keyed
   * by `toolUseId`. Rendered under the outcome line in both the overlay
   * (truncated to 8 lines) and flush (full diff) paths.
   */
  diff?: DiffPayload;
  /**
   * Set to `true` by {@link ToolLane.flushSource} the first time it emits
   * this entry's header line eagerly (before the entry's own done-event).
   * When `flush()` later processes the entry, it sees this flag and skips
   * re-emitting the header — instead it emits only the children/closer
   * portion via {@link formatAgentChildren}, so the frame closer lands at
   * the correct position in append-only scrollback without duplicating the
   * header.
   *
   * Invariant: only set on NESTING_TOOLS entries that are ancestors of a
   * `flushSource` target. Regular subagent entries (the ones that ARE the
   * `flushSource` target) are removed from the lane on flush and never see
   * this flag.
   */
  headerEmitted?: boolean;
  /**
   * Timestamp (Date.now()) when this entry was created — i.e. when the
   * tool_use_detail arrived. Set once at {@link ToolLane.addStart} /
   * {@link ToolLane.addStartWithAgentContext} and never mutated so the
   * elapsed counter ticks forward on every overlay repaint without
   * requiring a separate timer. Only read in the live overlay path
   * ({@link ToolLane.getOverlay}); never consulted during flush().
   */
  startedAt: number;
}

export type ToolEntry = ToolEntryFields & { kind: 'tool' };

/**
 * Construct a fresh `ToolEntry` with `startedAt` stamped at call time.
 * Extracted from {@link ToolLane.addStart} / {@link ToolLane.addStartWithAgentContext}
 * so tool-lane.ts can call a single function rather than repeating the full
 * object literal (keeping tool-lane.ts under the 350-code-line ratchet).
 */
export function freshToolEntry(
  toolUseId: string,
  toolName: string,
  toolInput: string,
  prefix: string,
  agentContext?: string,
): ToolEntry {
  const entry: ToolEntry = {
    kind: 'tool',
    toolUseId,
    toolName,
    toolInput,
    prefix,
    startedAt: Date.now(),
  };
  if (agentContext !== undefined) entry.agentContext = agentContext;
  return entry;
}

export interface TextEntry {
  kind: 'text';
  toolUseId: string;
  text: string;
  agentContext: string;
}

export type Entry = ToolEntry | TextEntry;

/**
 * Spine + connector glyph set.
 *
 * Two sets are defined:
 * - {@link UNICODE_GLYPHS}: box-drawing glyphs (`│`, `├─`, `╰─`) + a
 *   filled circle (`◉`) turn-root marker. Default in TTY terminals
 *   with modern monospace fonts.
 * - {@link ASCII_GLYPHS}: width-equivalent ASCII fallback (`|`, `+-`,
 *   `\-`, `o`). Used when `AGENT_AFK_ASCII=1` is set, or when stdout
 *   is not a TTY (pipes, CI, file redirects) where box-drawing glyphs
 *   may render incorrectly.
 *
 * Width invariants (matter for indent math; column-position bookkeeping
 * assumes they hold):
 * - `spine`, `spineClosed`, `turnRoot`, `turnRootClosed`: 2 cells
 * - `midConnector`, `lastConnector`: 3 cells
 * - `textPrefix` (the inline `│ ` prefix on wrapped text-child lines): 2 cells
 *
 * Both sets satisfy these invariants by construction.
 */
export interface Glyphs {
  /** Live spine column, e.g. `'│ '`. 2 cells. */
  spine: string;
  /** Closed spine column (branch already terminated), e.g. `'  '`. 2 cells. */
  spineClosed: string;
  /** Lead under a parent row that has no turn-root marker, e.g. `'  '`. 2 cells. */
  lead: string;
  /** Turn-root marker for the head row of a subagent dispatch, e.g. `'◉ '`. 2 cells. */
  turnRoot: string;
  /** Mid-sibling tree connector, e.g. `'├─ '`. 3 cells. */
  midConnector: string;
  /** Last-sibling tree connector, e.g. `'╰─ '`. 3 cells. */
  lastConnector: string;
  /** Inline prefix on wrapped text-child lines, e.g. `'│ '`. 2 cells. */
  textPrefix: string;
}

export const UNICODE_GLYPHS: Readonly<Glyphs> = Object.freeze({
  spine: '│ ',
  spineClosed: '  ',
  lead: '  ',
  turnRoot: '◉ ',
  midConnector: '├─ ',
  lastConnector: '╰─ ',
  textPrefix: '│ ',
});

export const ASCII_GLYPHS: Readonly<Glyphs> = Object.freeze({
  spine: '| ',
  spineClosed: '  ',
  lead: '  ',
  turnRoot: 'o ',
  midConnector: '+- ',
  lastConnector: '\\- ',
  textPrefix: '| ',
});

/**
 * Tree connector glyphs (Unicode set). Both are 3 display cells wide:
 *   `├─ ` — interior sibling (`MID`). Vertical tee + extension + space.
 *   `╰─ ` — last sibling (`LAST`). Rounded corner + extension + space.
 *
 * The `─` extension visually carries the branch toward its content
 * (cf. landing page's earned-path aesthetic — branches reach for their
 * destinations rather than sitting beside them). The rounded corner
 * (`╰` vs `└`) softens the bottom-of-branch turn.
 *
 * The trailing space is a separator so the connector reads cleanly into
 * both glyph-led prefixes (`├─ ● Read(...)`) and text-led synthetics
 * (`╰─ Done (4 tools · 2.5s)`).
 *
 * Constants exported for tests and external code paths that pin the
 * Unicode form (e.g. legacy assertions on `├` / `╰`). Runtime rendering
 * goes through {@link assignConnectors}, which reads the active glyph set
 * via {@link getGlyphs} — under ASCII mode the runtime connectors are
 * `'+- '` and `'\\- '` (same 3-cell width).
 */
export const TREE_CONNECTOR_MID = UNICODE_GLYPHS.midConnector;
export const TREE_CONNECTOR_LAST = UNICODE_GLYPHS.lastConnector;

/**
 * Read the active glyph set. Returns {@link ASCII_GLYPHS} when
 * `AGENT_AFK_ASCII=1` is set (case-insensitive, accepts `1`/`true`/`yes`),
 * else {@link UNICODE_GLYPHS}.
 *
 * Re-reads `process.env` on every call — cheap property access — so tests
 * can flip the mode by mutating the env between assertions. The result is
 * threaded through render helpers as a single frozen object so a top-level
 * render frame uses one consistent set.
 *
 * Non-TTY surfaces do NOT auto-switch to ASCII: pipes/CI redirects routinely
 * carry ANSI escapes and box-drawing fine. Forcing ASCII there would mangle
 * `expect(stripAnsi(...)).toContain('├')` assertions in tests. Opt-in only.
 */
export function getGlyphs(): Readonly<Glyphs> {
  const v = env.AGENT_AFK_ASCII;
  if (v && /^(1|true|yes)$/i.test(v)) return ASCII_GLYPHS;
  return UNICODE_GLYPHS;
}

/**
 * Build the plain (no-ANSI) indent for a row at depth N.
 *
 * Indent geometry (depth-N row, where N is the recursion depth of
 * `renderOverlayChildren` / `renderFlushChildren`):
 *
 *   ┌─ N-1 ancestor slots ─┐┌─ active spine ─┐┌─ connector ─┐
 *   │ '│ ' or '  ' (×N-1)  ││      '│ '      ││ '├─ '/'╰─ '│
 *   └──────────────────────┘└────────────────┘└────────────┘
 *
 * - ancestor slot i: '│ ' when ancestorIsLast[i] is false (parent at
 *   depth i+1 has more siblings below; its spine continues through
 *   the current row), '  ' when true (parent already closed its branch).
 * - active spine: '│ ' — the immediate parent of this row is currently
 *   being rendered (its children are below), so its column always shows
 *   a live spine.
 *
 * No screen-left lead is included. The depth-1 spine sits at column 0
 * directly under the turn-root marker (`◉ `, 2 cells) emitted on the
 * Agent head row by the caller (`formatAgentSummary` / `getOverlay`).
 * That gives a continuous vertical column from the turn-root through
 * all descendants — the topology metaphor the spine is for.
 *
 * Total width = 2*N cells. (Pre-spine-renderer was 2*(N+1); removing the
 * lead shifts every child row left by 2 cells. The corresponding shift
 * on the Agent head row is replacing `'  '` with `'◉ '` — same 2 cells,
 * different glyph — so the head row's content column is unchanged.)
 *
 * ancestorIsLast.length === depth - 1 (the immediate parent's last-ness
 * isn't tracked because its spine is unconditionally live at this row).
 *
 * Returned string is plain text suitable for `.length`-based wrap math;
 * {@link colorizeIndent} dims the `│` glyphs for emission. `g` carries the
 * active {@link Glyphs} set so Unicode/ASCII swap at a single call site.
 */
export function buildIndent(ancestorIsLast: readonly boolean[], g: Readonly<Glyphs>): string {
  let out = '';
  for (const isLast of ancestorIsLast) {
    out += isLast ? g.spineClosed : g.spine;
  }
  out += g.spine; // active spine for the current parent
  return out;
}

/**
 * Dim the `│` spine glyphs in an indent built by {@link buildIndent}.
 *
 * Per-slot dim (rather than `palette.dim(whole indent)`) so downstream
 * consumers that strip ANSI for measurement see the same plain layout
 * {@link buildIndent} produced. The leading `'  '` lead and any closed
 * `'  '` ancestor slots pass through unchanged.
 *
 * Walks 2 cells at a time — indents built by {@link buildIndent} are
 * composed exclusively of `g.spine` and `g.spineClosed` units (both 2
 * cells wide; see the width invariants on {@link Glyphs}).
 */
export function colorizeIndent(plainIndent: string, g: Readonly<Glyphs>): string {
  let out = '';
  for (let i = 0; i < plainIndent.length; i += 2) {
    const slot = plainIndent.slice(i, i + 2);
    out += slot === g.spine ? palette.dim(slot) : slot;
  }
  return out;
}

/**
 * Render a {@link TextEntry}'s text as one or more lines under the given
 * indent, prefixing every wrapped line with `│ ` (dim). Empty/whitespace-only
 * text returns no lines (caller should skip — avoids overlay flicker before
 * the first non-empty content delta).
 *
 * `indent` is the plain (no-ANSI) indent string produced by
 * {@link buildIndent}; the function dims spine glyphs at emission and
 * uses `.length` for wrap math (plain string of 2-cell units).
 */
export function renderTextChildLines(text: string, indent: string, g: Readonly<Glyphs>): string[] {
  if (!text || !text.trim()) return [];
  const prefix = palette.dim(g.textPrefix);
  // 2 cols for the text prefix, plus a small safety margin for ANSI widths.
  // Derived from `toolLaneWidth()` — the same row budget `clampLineToTerminal`
  // enforces on the composed line below — so the wrapped text can never
  // exceed the clamp that will later be applied to it (see `render/measure.ts`).
  const maxWidth = Math.max(1, toolLaneWidth() - indent.length - 2 - 2);
  const colored = colorizeIndent(indent, g);
  const out: string[] = [];
  for (const para of text.split('\n')) {
    // Sanitize each paragraph: strip ANSI/control codes from LLM-sourced
    // content before wrapping. Split on '\n' first so the LF→space
    // replacement inside sanitizeTextParagraph doesn't merge paragraphs.
    // Uses sanitizeTextParagraph (not sanitizeLabel) so leading indentation
    // — meaningful for markdown list bullets ("  - item") — survives into
    // the wrap pass. sanitizeLabel would trim the leading spaces and
    // collapse multi-space runs, flattening list structure into a single
    // continuous line.
    const safePara = sanitizeTextParagraph(para);
    const wrapped = wrapToWidth(safePara, maxWidth);
    for (const line of wrapped.split('\n')) {
      out.push(colored + prefix + line);
    }
  }
  return out;
}


// Re-export from grouping module
export {
  assignConnectors,
  addOverflowSynthetic,
  addResultSummarySynthetic,
  type GroupedSibling,
  type OverflowSibling,
  type ResultSummarySibling,
  type RenderableSibling,
  type ConnectedSibling,
} from './tool-lane-render-grouping.js';

// Re-export from children module
export { renderOverlayChildren, renderFlushChildren } from './tool-lane-render-children.js';

// Re-export from agent module
export {
  formatAgentSummary,
  formatAgentHeader,
  formatAgentChildren,
} from './tool-lane-render-agent.js';

// Re-export from grouped-root module
export {
  renderGroupedRootTools,
  formatGroupedToolResults,
} from './tool-lane-render-grouped-root.js';
