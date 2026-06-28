import { NESTING_TOOLS } from '../../tool-category.js';
import type { ToolEntry } from './tool-lane-render.js';
import { sanitizeLabel } from './tool-lane-format.js';

interface GroupedSibling {
  kind: 'group';
  toolName: string;
  label: string;
  entries: ToolEntry[];
}

/** Synthetic overflow placeholder produced by {@link addOverflowSynthetic}. */
export interface OverflowSibling {
  kind: 'overflow';
  count: number;
  /** Pre-formatted display text (categorical breakdown). */
  text: string;
}

/**
 * Recency window. If `siblings.length > maxVisible`, returns a single leading
 * synthetic {@link OverflowSibling} (summarizing the OLDER head) followed by
 * the MOST-RECENT `maxVisible` siblings, in dispatch order. Otherwise returns
 * `siblings` unchanged.
 *
 * History: siblings arrive in first-occurrence (chronological) order, so the
 * tail is the most recent activity — including the file mutations that
 * typically land late in a run. The pre-fix `slice(0, maxVisible)` kept the
 * OLDEST groups and collapsed the newest into the "+N" line, burying exactly
 * the recent work a watcher most wants to see (reported UX bug:
 * fix-tool-recency-display). Switching to the tail surfaces it; placing the
 * overflow FIRST keeps the block readable top→bottom — "… +N older", then the
 * newest groups — instead of inverting the timeline against the footnote.
 *
 * The overflow synthetic obeys `assignConnectors`'s positional rule like any
 * real sibling — it is added to the list BEFORE `assignConnectors` runs. As
 * the FIRST sibling it now receives the MID connector (`├`); the last visible
 * group (overlay path) or the appended result-summary (flush path) keeps the
 * LAST connector (`└`), so the exactly-one-last-child invariant is preserved.
 *
 * Accepts only real tool / grouped siblings (not overflow or resultSummary
 * synthetics) — those are added after this step.
 */
export function addOverflowSynthetic(
  siblings: Array<ToolEntry | GroupedSibling>,
  maxVisible: number,
): Array<ToolEntry | GroupedSibling | OverflowSibling> {
  if (siblings.length <= maxVisible) return siblings;
  const splitAt = siblings.length - maxVisible;
  const hidden = siblings.slice(0, splitAt);
  const visible = siblings.slice(splitAt);
  const text = formatCategoricalOverflow(hidden);
  return [{ kind: 'overflow', count: hidden.length, text }, ...visible];
}

/**
 * Pluralize a tool name for use in the categorical overflow line.
 *
 * Contract — rules (in order):
 *   1. `n ≤ 1` → unchanged.
 *   2. Ends in `s` → unchanged (avoid `process` → `processs`).
 *   3. Ends in sibilant cluster (sh, ch, x, z) → unchanged.
 *   4. Otherwise → append `s`.
 *
 * History: standard English would insert `-es` after sibilants (`bash` →
 *   `bashes`), but the pre-pluralization corpus (bash, fish, fsck) was the
 *   user-visible format for months. Conservative: leave sibilants invariant
 *   rather than introduce a second user-visible string break.
 */
function pluralizeToolName(name: string, n: number): string {
  if (n <= 1) return name;
  if (name.endsWith('s')) return name;
  // Sibilant clusters: appending bare `-s` is awkward and English would
  // normally use `-es`. Keep these invariant — the corpus is too small
  // for a second user-visible format break to be worth the gain.
  if (/(sh|ch|x|z)$/i.test(name)) return name;
  return name + 's';
}

/**
 * Maximum number of dispatch label rows to show inline in the overflow line.
 * Beyond this threshold the remainder is summarised with a `(+N)` suffix
 * counting the *entries* (not rows) hidden by the cap.
 *
 * Example with LABEL_LIST_CAP=5 and 8 hidden agents:
 *   … +8 more: pr1, pr2, pr3, pr4, pr5 (+3)
 *
 * When a group with `entries.length > 1` lands in the visible portion,
 * the row carries an explicit `×N` suffix, e.g. `pr1 ×3`. This keeps the
 * row-cap and the entry-total reconcilable: the rendered `×N` suffixes
 * plus the trailing `(+M)` always sum to the leading `+TOTAL`.
 */
const LABEL_LIST_CAP = 5;

/**
 * Per-label display ceiling (display columns). A single LLM-generated
 * label larger than this is truncated with a trailing ellipsis. Prevents
 * a runaway label string from blowing up the overflow line.
 */
const LABEL_DISPLAY_MAX = 60;

/**
 * Bucket hidden children by toolName for a categorical overflow line.
 *
 * Two stable grammar variants, discriminated by the presence of the
 * literal token `more:`:
 *
 *   1. Categorical (default):  `… +N (3 Agents, 2 Reads, 1 Grep)`
 *   2. Label-aware (special):  `… +N more: pr316, pr308, pr239`
 *                              `… +N more: pr1 ×3, pr2, pr3`
 *                              `… +N more: pr1, pr2, pr3, pr4, pr5 (+1)`
 *
 * Downstream parsers can distinguish by matching `^… \+\d+ \(` vs.
 * `^… \+\d+ more:`. Both formats are stable; do not flip the discriminator.
 *
 * The label-aware variant fires only when ALL hidden items are
 * dispatch-class (NESTING_TOOLS), share a single toolName (homogeneous),
 * and every label is paren-wrapped (post-merge). It preserves per-agent
 * identity when a compose wave hides agents.
 *
 * Count invariant: the leading `+N` is the total entry count. When a
 * group lands in `hidden`, its entries are represented by ONE label row
 * carrying an explicit `×count` suffix so the rendered row count and the
 * label-row count never disagree. The trailing `(+M)` (when label rows
 * exceed LABEL_LIST_CAP) expresses ENTRIES hidden by the cap, not rows —
 * i.e. visible-row entry-sum plus `(+M)` always sums to `+N`.
 *
 * Falls back to categorical when:
 *   - Any hidden item is not dispatch-class, OR
 *   - Mix of different toolNames (heterogeneous — e.g. `Agent` + `skill`), OR
 *   - Any label is empty or not paren-wrapped (pre-merge placeholder).
 *
 * Why the paren-wrap shape check matters: between the early `tool.use.start`
 * fire (`translate.ts` emits `' …'`) and the post-stream `tool.use.start`
 * (`loop.ts` emits `summarizeToolInput(name, input)`, which returns `''` for
 * `agent`/`compose` whose label is only known after dispatch), and the
 * subsequent `mergeAgentLabel`/`Agent(<label>)` synthesis, those dispatch
 * entries carry placeholder `toolInput` values that MUST NOT be rendered as
 * labels. Paren-wrapped `(label)` is the protocol signal that the entry has
 * been promoted to its labeled form. (`skill` is the exception: its label is
 * the input's `name` field, so `summarizeToolInput` returns the paren-wrapped
 * `(skillname)` directly — already promoted, no deferred merge needed.)
 *
 * Only called with real tool / grouped siblings (never overflow or
 * resultSummary synthetics) — those are added AFTER the overflow is computed.
 */
export function formatCategoricalOverflow(hidden: Array<ToolEntry | GroupedSibling>): string {
  const counts = new Map<string, number>();
  let total = 0;
  for (const item of hidden) {
    if (item.kind === 'group') {
      counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + item.entries.length);
      total += item.entries.length;
    } else {
      counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
      total += 1;
    }
  }
  if (total === 0) return '';

  // ── Label-aware path ────────────────────────────────────────────────────
  // Fires only when ALL hidden items are dispatch-class, share a single
  // toolName (homogeneous), and carry paren-wrapped labels.
  const allDispatch =
    hidden.length > 0
    && hidden.every((item) => NESTING_TOOLS.has(item.toolName))
    && new Set(hidden.map((i) => i.toolName)).size === 1;
  if (allDispatch) {
    // Each label row tracks how many entries it represents so the
    // categorical-total invariant holds even when a group lands in `hidden`.
    // Row count != entry count for groups (entries.length > 1).
    const labels: Array<{ display: string; entries: number }> = [];
    let bail = false;
    for (const item of hidden) {
      const labelInput = item.kind === 'group' ? item.label : item.toolInput;
      const trimmed = labelInput.trim();
      // Paren-wrap is the protocol signal that the entry has been promoted
      // to its labeled form. Pre-merge placeholders (' …' from translate.ts,
      // '' from loop.ts before mergeAgentLabel runs) must fall back to the
      // categorical bucket — otherwise ellipsis/empty leaks as a "label".
      if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) { bail = true; break; }
      const raw = trimmed.slice(1, -1);
      // Sanitize before length-check: control characters would otherwise
      // count toward LABEL_DISPLAY_MAX while contributing zero display width.
      const sanitized = sanitizeLabel(raw);
      if (!sanitized) { bail = true; break; }
      // Truncate runaway labels so a multi-KB toolInput can't blow up the line.
      const display = sanitized.length > LABEL_DISPLAY_MAX
        ? sanitized.slice(0, LABEL_DISPLAY_MAX - 1) + '…'
        : sanitized;
      const entries = item.kind === 'group' ? item.entries.length : 1;
      labels.push({ display, entries });
    }
    if (!bail && labels.length > 0) {
      const visible = labels.slice(0, LABEL_LIST_CAP);
      // Entry-total honesty: when a row represents a group, render its
      // entry count inline so the rendered numbers reconcile with the
      // leading `+total`. Single-entry rows get no suffix (cleanest read).
      const rendered = visible.map(({ display, entries }) =>
        entries > 1 ? `${display} ×${entries}` : display,
      );
      // Entries actually shown across all visible rows.
      const visibleEntries = visible.reduce((sum, l) => sum + l.entries, 0);
      const hiddenEntries = total - visibleEntries;
      const labelStr = rendered.join(', ') +
        (hiddenEntries > 0 ? ` (+${hiddenEntries})` : '');
      return `… +${total} more: ${labelStr}`;
    }
    // Fall through to categorical if any label was empty / unwrapped /
    // failed sanitization.
  }

  // ── Categorical path ────────────────────────────────────────────────────
  const buckets: string[] = [];
  for (const [name, n] of counts) {
    buckets.push(`${n} ${pluralizeToolName(name, n)}`);
  }
  return `… +${total} (${buckets.join(', ')})`;
}
