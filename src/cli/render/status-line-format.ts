/**
 * Pure formatting for the status-line row.
 *
 * Assembles status segments (model, cwd, branch, mode, context bar, cost,
 * tokens, quota, turn, budget, agents, tok/s) into a single ANSI string,
 * then applies priority-based shedding so narrow terminals drop peripheral
 * fields before right-edge truncation loses model info.
 *
 * Extracted from StatusLine.formatLine() — the class calls this function
 * and supplies `maxW` (terminal width minus margin).
 */

import { basename, dirname } from 'node:path';
import type { PermissionMode } from '../../agent/types/sdk-types.js';
import { truncateDisplayWidth, displayWidth } from '../display.js';
import { palette } from '../palette.js';
import { formatContextBar } from './context-bar.js';
import { formatQuotaIndicator, type QuotaWindows } from '../quota-indicator.js';
import { formatCwd } from '../format-cwd.js';
import { formatTokens } from '../format-utils.js';

export interface StatusLineFields {
  model: string;
  cost?: number;
  tokens?: number;
  contextPct?: number;
  contextLimit?: number;
  contextUsedTokens?: number;
  contextSparkline?: string;
  /**
   * Current REPL permission mode. Renders a never-dropped indicator: `○ default`
   * (default/contained mode, success tone), `● plan` (plan mode, warning tone),
   * `◐ AFK` (autonomous/AFK mode, info tone), or `⚡ bypass` (bypassPermissions,
   * bypass tone — a cool "full-power" badge, not a caution glyph).
   */
  permissionMode?: PermissionMode;
  /**
   * Effective working directory for the session. Rendered leftmost so that
   * right-edge truncation (which strips trailing parts first) preserves the
   * cwd — the field that answers "where am I?" at a glance is the one most
   * worth keeping visible on narrow terminals.
   */
  cwd?: string;
  /**
   * Current git branch (e.g. `feat/x`). Rendered after the cwd as `⎇ <branch>`
   * — both are "where am I?" identity fields. Undefined on a detached HEAD or
   * outside a git repo, in which case no branch segment is drawn. Sampled
   * off-thread (see git-status-sampler.ts), so this is a cache read.
   */
  branch?: string;
  /**
   * Open PR number for the current branch, appended to the branch segment as
   * `#<n>` (e.g. `⎇ feat/x #123`). Undefined when there is no open PR for the
   * branch, when `gh` is unavailable, or before the (network) lookup settles.
   * Only meaningful alongside `branch`.
   */
  pr?: number;
  /**
   * Claude subscription quota windows (5h / 7d rolling utilization + reset
   * deadlines), or undefined when no quota headers have been observed in this
   * process — which is the PERMANENT state under API-key auth, since only
   * subscription OAuth responses carry `anthropic-ratelimit-unified-*`.
   * Undefined must draw no segment at all rather than a placeholder.
   *
   * Passed RAW (not pre-formatted) so the line can grade the segment's tone AND
   * its droppability from the same severity — see the render block below.
   * Mirrors how `contextPct`/`contextLimit` are passed raw for
   * `formatContextBar`.
   */
  quotaWindows?: QuotaWindows;
  /**
   * Current turn number (1-based count of completed turns in this session).
   * Rendered as `turn N` when no budget is set, or `turn N/M` when `maxTurns`
   * is also provided. Undefined means "no turn info available yet" and draws no
   * segment at all.
   *
   * Given a LOW drop priority (sheds before branch, after cost) so it never
   * pushes model/mode off the line on narrow terminals. The N/M form reveals
   * budget constraint — valuable during a bounded run, invisible otherwise.
   */
  turnCount?: number;
  /**
   * Maximum turns configured for this session (from `--max-turns` / `maxTurns`
   * config). When present alongside `turnCount`, renders the indicator as
   * `turn N/M` so the user can see how far into the budget they are. Optional —
   * 0 or undefined means "no turn cap" and the segment shows just `turn N`.
   */
  maxTurns?: number;
  /**
   * Cumulative session cost in USD. When `maxBudgetUsd` is also set, renders
   * as `$N.NN/$M.NN` to show spend against cap. Without a cap, renders the
   * same as the existing `cost` field. Takes droppablePriority 7 (shed before
   * turnCount) — the most peripheral of the budget fields.
   *
   * NOTE: This field is separate from `cost` (which the existing status line
   * uses for the raw cost display). `budgetUsd` is the new field that pairs
   * with `maxBudgetUsd` for budget-aware rendering and a slightly different
   * drop priority in the shed order.
   */
  budgetUsd?: number;
  /**
   * Maximum allowed session spend in USD (from a cost-budget config). When
   * present alongside `budgetUsd`, the segment renders as `$N.NN/$M.NN`.
   * Optional — 0 or undefined means no cap.
   */
  maxBudgetUsd?: number;
  /**
   * Number of background subagent jobs currently in the 'running' state.
   * Only rendered when > 0 as `N↗` to signal active parallel fan-out.
   * Undefined or 0 means no active background agents — draws no segment.
   * Takes droppablePriority 8 (shed after tokPerSec) — sheds after
   * tokPerSec (priority 9) on the narrowest terminals.
   */
  activeAgentCount?: number;
  /**
   * Live tokens-per-second rate during model streaming, computed by the
   * MomentumTicker module. Rendered as `847 tok/s` only while the model is
   * streaming; the field is undefined (and the segment absent) between turns.
   * Takes droppablePriority 9 (shed before activeAgentCount) — the most
   * peripheral field; vanishes first on narrow terminals.
   */
  tokPerSec?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

interface Part {
  text: string;
  droppablePriority?: number; // undefined = never drop, higher = drop first
}

/** Build the `⎇ branch #PR` segment shared by both the dedupe and non-dedupe paths. */
function buildGitSegment(branch: string, pr: number | undefined): string {
  const branchText = truncateDisplayWidth(branch, 30);
  let seg = `${palette.dim('⎇')} ${palette.chrome(branchText)}`;
  if (pr !== undefined) seg += ` ${palette.meta(`#${pr}`)}`;
  return seg;
}

// ── Main formatter ───────────────────────────────────────────────────

/**
 * Assemble a status-line string from fields, fitting within `maxW` display
 * columns. Segments are tagged with droppability priorities; when the line
 * exceeds `maxW`, the highest-priority (most peripheral) droppable segments
 * are shed first. If still too wide after shedding all droppables, the line
 * is right-truncated.
 *
 * Invariant: parts are built in semantic order (model, cwd/branch, plan,
 * context, cost, tokens), tagged with droppability priority so narrow
 * terminals can shed lower-priority fields before resorting to right-edge
 * truncation that arbitrarily loses model info. Drop order (drop-first to
 * drop-last): tokens, cost, context bar, branch. The branch drops LAST
 * among droppables because it is identity ("which branch am I on?"), like
 * cwd. Never drop: model, cwd, plan. Model is pushed FIRST (#1343) so it
 * occupies the leftmost slot -- the position the eye reaches first when
 * scanning a narrow tmux pane. When cwd and branch are deduped into one
 * merged segment (see worktreeDedupe below), that segment inherits the
 * branch's droppablePriority 1 (drop-last among droppables), NOT never-drop:
 * a never-drop location there would stack with the never-drop model and
 * force right-edge truncation to lose model info on a narrow terminal, so
 * the location sheds before the model is ever truncated.
 */
export function formatStatusLine(f: StatusLineFields, maxW: number): string {
  // Tone hierarchy (all existing palette roles -- no new hex): the row earns a
  // "finished" read from CONTRAST between tiers, not uniform brightness.
  //   primary   -- model (brand) + mode chip (plan/AFK/bypass): already colored.
  //   secondary -- branch, cost, tokens, context %: readable `chrome` slate
  //               (lifted from near-invisible `meta`/`dim`) so they're legible.
  //   recessive -- cwd path, separators, `⎇`/bar-track glyphs: stay `dim`/`meta`.
  // cwd deliberately stays recessive: it is the longest field, and lifting it
  // too would flatten the hierarchy back into a wash and compete with the
  // conversation above. Tone is width-neutral (ANSI is stripped by displayWidth),
  // so none of the drop/truncate math below is affected.
  let parts: Part[] = [];

  // Model chip: never-drop, leftmost. Placing it first protects it from
  // right-edge truncation -- any right-edge shear always hits the rightmost
  // fields (tokens, cost, context) first (#1343).
  parts.push({ text: palette.brand(f.model) });

  // Invariant: afk-worktree cwd/branch dedupe. `.afk-worktrees/<slug>`
  // directories are named by replacing `/` with `-` in the branch that
  // seeded them (see createWorktreeAt, commands/interactive/worktree.ts),
  // so for that pattern cwd and branch carry the SAME identity string
  // twice. Three conditions must ALL hold before the cwd is suppressed:
  //   1. the cwd's PARENT directory is literally `.afk-worktrees`
  //   2. the slash-normalized branch equals the cwd basename
  //   3. the branch fits the 30-col cap uncut
  // Comparison runs on EVERY repaint (uncached): the branch comes from
  // GitStatusSampler and can change mid-session, so a cached compare
  // could go stale. Uses the RAW cwd, not the formatCwd() output.
  const worktreeDedupe =
    f.cwd !== undefined &&
    f.branch !== undefined &&
    basename(dirname(f.cwd)) === '.afk-worktrees' &&
    f.branch.replaceAll('/', '-') === basename(f.cwd) &&
    displayWidth(f.branch) <= 30;

  if (worktreeDedupe) {
    // Matched: cwd is pure duplication of the branch identity, so omit it.
    // droppablePriority 1 = drop-LAST among droppables (not never-drop).
    parts.push({ text: buildGitSegment(f.branch!, f.pr), droppablePriority: 1 });
  } else {
    // Cwd leads the line. Cap its share at ~40% so a deep path can't shove
    // the model/cost/context pieces off the right edge.
    if (f.cwd) {
      const cwdBudget = Math.max(8, Math.floor(maxW * 0.4));
      const formatted = formatCwd(f.cwd, { maxWidth: cwdBudget });
      if (formatted) parts.push({ text: palette.dim(formatted) }); // never drop
    }

    // Git branch (+ open PR) sits next to the cwd.
    if (f.branch) {
      parts.push({ text: buildGitSegment(f.branch, f.pr), droppablePriority: 1 });
    }
  }

  // Permission mode chip (never-drop).
  if (f.permissionMode === 'plan') {
    parts.push({ text: palette.warning('● plan') });
  } else if (f.permissionMode === 'autonomous') {
    parts.push({ text: palette.info('◐ AFK') });
  } else if (f.permissionMode === 'bypassPermissions') {
    parts.push({ text: palette.bypass('⚡ bypass') });
  } else if (f.permissionMode === 'default') {
    parts.push({ text: palette.success('○ default') });
  }

  if (f.contextPct !== undefined) {
    const barOutput = formatContextBar({
      ratio: f.contextPct,
      used: f.contextUsedTokens,
      limit: f.contextLimit,
      sparkline: f.contextSparkline,
      width: maxW,
    });
    parts.push({ text: barOutput, droppablePriority: 2 });
  }

  if (f.cost !== undefined) {
    parts.push({ text: palette.chrome(`$${f.cost.toFixed(2)}`), droppablePriority: 3 });
  }

  if (f.tokens !== undefined) {
    parts.push({ text: palette.chrome(`${formatTokens(f.tokens)} tokens`), droppablePriority: 4 });
  }

  // Invariant: every droppablePriority on this line must be UNIQUE. The shed
  // loop drops EVERY part sharing the current maximum priority in one pass.
  //
  // Contract: quota droppability is SEVERITY-INVERTED. At calm/caution it is 5
  // (drop first). At `critical` (>80% of a rolling window) it becomes 0 (drop
  // LAST) -- the one moment the quota is the most important field is exactly
  // the moment a narrow terminal used to shed it first. Promotion requires a
  // FRESH reading: stale critical keeps the peripheral priority.
  if (f.quotaWindows !== undefined) {
    const quota = formatQuotaIndicator(f.quotaWindows);
    if (quota !== undefined) {
      const priority = quota.severity === 'critical' && !quota.stale ? 0 : 5;
      parts.push({ text: quota.text, droppablePriority: priority });
    }
  }

  // Turn / budget indicator -- droppablePriority 6 (shed FIRST).
  if (f.turnCount !== undefined) {
    const capSuffix = f.maxTurns && f.maxTurns > 0 ? `/${f.maxTurns}` : '';
    parts.push({
      text: palette.chrome(`turn ${f.turnCount}${capSuffix}`),
      droppablePriority: 6,
    });
  }

  // Token budget consumption -- droppablePriority 7.
  if (f.budgetUsd !== undefined) {
    const capSuffix =
      f.maxBudgetUsd !== undefined && f.maxBudgetUsd > 0
        ? `/$${f.maxBudgetUsd.toFixed(2)}`
        : '';
    parts.push({
      text: palette.chrome(`$${f.budgetUsd.toFixed(2)}${capSuffix}`),
      droppablePriority: 7,
    });
  }

  // Active parallel subagent count -- droppablePriority 8.
  if (f.activeAgentCount !== undefined && f.activeAgentCount > 0) {
    parts.push({
      text: palette.chrome(`${f.activeAgentCount}↗`),
      droppablePriority: 8,
    });
  }

  // Live tok/s momentum ticker -- droppablePriority 9 (most peripheral).
  if (f.tokPerSec !== undefined && f.tokPerSec > 0) {
    parts.push({
      text: palette.chrome(`${Math.round(f.tokPerSec)} tok/s`),
      droppablePriority: 9,
    });
  }

  // Join, measure, shed, truncate.
  const separator = palette.dim(' · ');
  let joined = parts.map((p) => p.text).join(separator);

  if (displayWidth(joined) <= maxW) return joined;

  // Shed the highest-droppablePriority (most peripheral) segments first.
  let droppable = parts.filter((p) => p.droppablePriority !== undefined);
  while (droppable.length > 0 && displayWidth(joined) > maxW) {
    const maxPriority = Math.max(...droppable.map((p) => p.droppablePriority!));
    parts = parts.filter((p) => p.droppablePriority === undefined || p.droppablePriority !== maxPriority);
    joined = parts.map((p) => p.text).join(separator);
    droppable = parts.filter((p) => p.droppablePriority !== undefined);
  }

  return truncateDisplayWidth(joined, maxW);
}
