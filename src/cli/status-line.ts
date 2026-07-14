/**
 * Persistent bottom-of-terminal status line.
 *
 * Reserves the last terminal row, parks the cursor above it, and repaints on
 * demand. Implemented with raw ANSI escape sequences — no ink, no readline
 * takeover. TTY-gated: on non-TTY stdouts the StatusLine is a no-op.
 *
 * Usage:
 *   const status = new StatusLine();
 *   status.start();
 *   status.repaint({ model: 'sonnet', cost: 0.02, tokens: 1200, contextPct: 0.12 });
 *   status.stop();   // before exit
 */

import { basename, dirname } from 'node:path';
import type { PermissionMode } from '../agent/types/sdk-types.js';
import { truncateDisplayWidth, displayWidth } from './display.js';
import { palette } from './palette.js';
import { ResizeBus } from './terminal-size.js';
import { formatContextBar } from './context-bar.js';
import { formatCwd } from './format-cwd.js';
import { isPlainOutputRequested } from '../config/env.js';

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
}

interface StatusLineOpts {
  /** Stream to write escape codes to. Defaults to process.stdout. */
  stream?: NodeJS.WriteStream;
  /** Force-enable even on non-TTY (tests). */
  force?: boolean;
  /** Minimum ms between repaints — avoids flicker on fast streams. */
  throttleMs?: number;
}

export class StatusLine {
  private readonly stream: NodeJS.WriteStream;
  private readonly force: boolean;
  private readonly throttleMs: number;
  private started = false;
  private lastRepaint = 0;
  private lastFields: StatusLineFields | null = null;
  private resizeUnsub: (() => void) | null = null;
  private resizeImmediateUnsub: (() => void) | null = null;
  private lastPaintedRow: number | null = null;
  /** Captures lastPaintedRow at SIGWINCH time for onResize() to use as the stale-row target. */
  private preResizePaintedRow: number | null = null;
  private extraRows = 0;
  private afterScrollRestore: (() => void) | null = null;

  constructor(opts: StatusLineOpts = {}) {
    this.stream = opts.stream ?? process.stdout;
    this.force = opts.force ?? false;
    this.throttleMs = opts.throttleMs ?? 100;
  }

  private get enabled(): boolean {
    // AFK_PLAIN_OUTPUT / --plain is a full render opt-out: a TTY session with
    // the flag set must behave like a non-TTY surface, so the DECSTBM scroll
    // region and cursor-positioned status row are suppressed exactly as they
    // are on a genuine non-TTY stdout (where `isTTY` is false). Every escape-
    // emitting method routes through this getter, so gating here neutralizes
    // start/repaint/setExtraRows/onResize/rearm/withFullScrollRegion/stop in
    // one place. Mirrors the compositor/renderer/input gates that also consult
    // `isPlainOutputRequested` (config/env.ts). `force` (tests) still wins.
    return this.force || (!!this.stream.isTTY && !isPlainOutputRequested());
  }

  /** Reserve the bottom row by reducing the scroll region. */
  start(): void {
    if (this.started || !this.enabled) return;
    this.started = true;
    this.lastRepaint = 0;
    const rows = this.currentRows();
    // Preserve the current cursor so startup/resize arming does not clobber
    // already-rendered output above the reserved status row.
    this.stream.write('\x1b[s');
    this.writeScrollRegion(rows);
    this.stream.write('\x1b[u');
    if (this.resizeUnsub === null) {
      this.resizeUnsub = ResizeBus.subscribe(() => {
        this.onResize();
      });
      this.resizeImmediateUnsub = ResizeBus.subscribeImmediate(() => this.resetGeometry());
    }
  }

  private resetGeometry(): void {
    // Invariant: capturing `lastPaintedRow` into `preResizePaintedRow` BEFORE
    // nulling it is critical to preserve the stale-row-clear capability of
    // onResize() while also preventing mid-window repaint() calls from
    // corrupting the stale-row reference.
    //
    // The race this method prevents:
    //   SIGWINCH fires → stream.rows changes to newRows.
    //   A repaint(fields) call arrives in the 150ms debounce window (e.g. from a
    //   streaming token event).  repaint() writes to paintRow(newRows) and sets
    //   lastPaintedRow = paintRow(newRows).
    //   When onResize() finally fires, it reads lastPaintedRow = paintRow(newRows)
    //   and (correctly) sees that lastPaintedRow === paintRow(newRows), so it
    //   emits NO clear for the old row.  The pre-SIGWINCH content at
    //   paintRow(oldRows) is never erased — a visible stale-row artifact remains.
    //
    // By snapshotting lastPaintedRow → preResizePaintedRow here and nulling
    // lastPaintedRow synchronously, we achieve two goals simultaneously:
    //   1. onResize() reads preResizePaintedRow (the true pre-SIGWINCH row)
    //      for the old-row clear, immune to any mid-window repaint() mutation
    //      of lastPaintedRow.
    //   2. Mid-window repaint() writes to the new paintRow and seeds
    //      lastPaintedRow = paintRow(newRows).  Because lastPaintedRow was
    //      nulled, the mid-window repaint runs unconditionally (throttle gate
    //      open via lastRepaint=0) and does not attempt to clear a stale row
    //      on its own — onResize() will handle that.
    //
    // This must execute on the IMMEDIATE channel (ResizeBus.subscribeImmediate)
    // so the snapshot is taken synchronously inside the 'resize' event, before
    // any macrotask (streaming event, spinner tick) can mutate lastPaintedRow.
    this.preResizePaintedRow = this.lastPaintedRow;
    this.lastPaintedRow = null;
    this.lastRepaint = 0;
  }

  /** Re-anchor DECSTBM when the terminal height changes, then repaint. */
  private onResize(): void {
    if (!this.started || !this.enabled) return;
    const rows = this.currentRows();
    // Use preResizePaintedRow (set by resetGeometry() on the immediate channel)
    // as the authoritative old-row reference.  lastPaintedRow may have been
    // updated by a mid-window repaint() call and therefore already reflects the
    // new geometry — using it here would skip the necessary old-row clear.
    const rowToErase = this.preResizePaintedRow ?? this.lastPaintedRow;
    this.preResizePaintedRow = null;
    this.stream.write('\x1b[s');
    if (rowToErase !== null && rowToErase !== this.paintRow(rows)) {
      this.stream.write(`\x1b[${rowToErase};1H`);
      this.stream.write('\x1b[2K');
    }
    this.writeScrollRegion(rows);
    this.stream.write('\x1b[u');
    this.flush();
  }

  /** Repaint the status line with the given fields. */
  repaint(fields: StatusLineFields): void {
    if (!this.enabled || !this.started) {
      this.lastFields = fields;
      return;
    }
    const now = Date.now();
    if (now - this.lastRepaint < this.throttleMs) {
      this.lastFields = fields;
      return;
    }
    this.lastRepaint = now;
    this.lastFields = fields;

    const rows = this.currentRows();
    // Save cursor, move to bottom row, clear line, paint, restore.
    this.stream.write('\x1b[s');
    this.stream.write(`\x1b[${this.paintRow(rows)};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write(this.formatLine(fields));
    this.stream.write('\x1b[u');
    this.lastPaintedRow = this.paintRow(rows);
  }

  /** Force an immediate repaint bypassing the throttle. */
  flush(): void {
    this.lastRepaint = 0;
    if (this.lastFields) this.repaint(this.lastFields);
  }

  /**
   * Reserve additional rows above the status line (e.g. for the background
   * task bar). Adjusts the DECSTBM scroll region to leave room.
   */
  setExtraRows(n: number): void {
    this.extraRows = n;
    if (this.started && this.enabled) {
      const rows = this.currentRows();
      this.stream.write('\x1b[s');
      this.writeScrollRegion(rows);
      this.stream.write('\x1b[u');
      this.flush();
    }
  }

  /** Returns the current extra-rows reservation count. */
  getExtraRows(): number {
    return this.extraRows;
  }

  /**
   * Register a callback fired at the END of every {@link withFullScrollRegion}
   * cycle, immediately after the scroll region is re-established and the status
   * line is re-flushed.
   *
   * Why this exists: `withFullScrollRegion` performs a FULL-SCREEN scroll (so
   * the displaced top line enters scrollback — see the method's doc). That
   * scroll drags the entire reserved footer UP with it: not just this status
   * row (which self-heals here via `flush()`), but also the rows OWNED by the
   * loop-stage rail and the background-task bar that sit in the `extraRows`
   * band just above the status line. Those bars do NOT otherwise repaint after
   * a scroll (only on ResizeBus), so their scrolled-up copies orphan — the
   * most visible symptom being a DUPLICATE status row one line above the rail
   * (the live frame's bottom is `rows-1-extraRows`, so it no longer covers the
   * `rows-1` row the status copy lands on once `extraRows > 0`; see #634).
   *
   * The caller (repl-loop) registers a callback that redraws those footer bars
   * so they self-heal exactly like the status line. Fired AFTER `flush()` so
   * the status row is already correct and the bars repaint over the
   * higher rows. Each bar brackets its own write in save/restore, so the
   * cursor `withFullScrollRegion` preserved for the next compositor repaint
   * survives.
   */
  setAfterScrollRestore(cb: (() => void) | null): void {
    this.afterScrollRestore = cb;
  }

  /**
   * Re-establish the scroll region and repaint. Call after anything that
   * resets the terminal scroll region (e.g. log-update teardown).
   */
  rearm(): void {
    if (!this.started || !this.enabled) return;
    const rows = this.currentRows();
    this.stream.write('\x1b[s');
    this.writeScrollRegion(rows);
    this.stream.write('\x1b[u');
    this.flush();
  }

  /**
   * Run `fn` with the DECSTBM scroll region temporarily reset to the full
   * screen, so any `\n` written by `fn` that lands at the bottom row causes
   * a full-screen scroll (which enters the terminal's scrollback buffer)
   * rather than a sub-region scroll (which on xterm/iTerm2/Apple Terminal
   * silently discards displaced lines).
   *
   * External constraint (VT100/DECSTBM contract): `ESC [ <t> ; <b> r` sets
   * the scrolling region. Lines that exit the *top* of a sub-region via an
   * `\n` at the bottom of that region do not enter scrollback on standard
   * xterm-derived emulators. Resetting to full-screen (`ESC [ r`) for the
   * duration of the write makes the same `\n` produce a scrollback-bound
   * scroll instead.
   *
   * Sequence (each step is mandatory and order-sensitive):
   *   1. save cursor, emit `ESC [ r` to reset DECSTBM to full screen, restore
   *      cursor — DECSTBM homes the cursor to (1,1) per DEC VT spec, so
   *      without bracketing save/restore the inner fn() write would land at
   *      the top of the screen instead of the caller's cursor.
   *   2. invoke fn() — writes happen with full-screen scroll semantics
   *   3. save cursor, re-establish the prior DECSTBM region via
   *      writeScrollRegion(), restore cursor — again, the DECSTBM re-arm
   *      homes the cursor, so we must save the post-fn position first.
   *   4. flush() to re-paint the status line at the bottom row in case
   *      step 2 caused a full-screen scroll that displaced it. flush() does
   *      its own save/restore around the status repaint, so the cursor we
   *      restored in step 3 survives.
   *
   * External constraint (DEC VT spec): CSI r (DECSTBM, with or without
   * arguments) moves the cursor to the home position (1,1). Every other
   * DECSTBM emit in this file (start, onResize, repaint, stop) brackets
   * the emit with `\x1b[s` / `\x1b[u`; this method must too. Tested by
   * `cursor preservation` cases in status-line.test.ts.
   *
   * No-op (returns fn() directly) when status line is not started or
   * not enabled (non-TTY): the scroll region is not active, so the
   * sub-region scroll loss cannot occur.
   */
  withFullScrollRegion<T>(fn: () => T): T {
    if (!this.started || !this.enabled) return fn();
    // Save before DECSTBM reset so fn() resumes from the caller's cursor,
    // not the (1,1) home position the reset would otherwise leave us at.
    this.stream.write('\x1b[s');
    this.stream.write('\x1b[r');
    this.stream.write('\x1b[u');
    try {
      return fn();
    } finally {
      const rows = this.currentRows();
      // Save before DECSTBM re-arm so the post-fn cursor (where fn() left
      // off) survives the re-arm's cursor-home. flush() then does its own
      // save/restore around the status repaint, preserving this cursor for
      // whatever runs next (typically the compositor's repaint).
      this.stream.write('\x1b[s');
      this.writeScrollRegion(rows);
      this.stream.write('\x1b[u');
      this.flush();
      // Re-assert the footer bars (loop-stage rail, background-task bar) that
      // the full-screen scroll dragged upward. Without this their scrolled-up
      // copies orphan above the status row — see setAfterScrollRestore().
      this.afterScrollRestore?.();
    }
  }

  /** Release the scroll region and clear the status row. */
  stop(): void {
    if (this.resizeUnsub !== null) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    if (this.resizeImmediateUnsub !== null) {
      this.resizeImmediateUnsub();
      this.resizeImmediateUnsub = null;
    }
    if (!this.started || !this.enabled) {
      this.started = false;
      return;
    }
    const rows = this.currentRows();
    this.stream.write('\x1b[s');
    // Symmetric with onResize(): prefer preResizePaintedRow so a mid-debounce
    // repaint() that re-seeded lastPaintedRow to the new geometry doesn't cause
    // stop() to erase the wrong (new-geometry) row.
    const rowToErase = this.preResizePaintedRow ?? this.lastPaintedRow ?? this.paintRow(rows);
    this.stream.write(`\x1b[${rowToErase};1H`);
    this.stream.write('\x1b[2K');
    // Reset scroll region to full.
    this.stream.write('\x1b[r');
    this.stream.write('\x1b[u');
    this.started = false;
    this.lastRepaint = 0;
    this.lastPaintedRow = null;
    this.preResizePaintedRow = null;
  }

  private formatLine(f: StatusLineFields): string {
    // Invariant: parts are built in semantic order (cwd/branch, model, plan,
    // context, cost, tokens), tagged with droppability priority so narrow
    // terminals can shed lower-priority fields before resorting to right-edge
    // truncation that arbitrarily loses model info. Drop order (drop-first →
    // drop-last): tokens → cost → context bar → branch. The branch drops LAST
    // among droppables because it is identity ("which branch am I on?"), like
    // cwd. Never drop: cwd, model, plan. When cwd and branch are deduped into
    // one merged segment (see worktreeDedupe below), that segment inherits the
    // branch's droppablePriority 1 (drop-last among droppables), NOT never-drop:
    // a never-drop location there would stack with the never-drop model and
    // force right-edge truncation to lose model info on a narrow terminal, so
    // the location sheds before the model is ever truncated.
    interface Part {
      text: string;
      droppablePriority?: number; // undefined = never drop, higher = drop first
    }

    let parts: Part[] = [];
    const maxW = Math.max(4, (this.stream.columns ?? 80) - 2);

    // Invariant: afk-worktree cwd/branch dedupe. `.afk-worktrees/<slug>`
    // directories are named by replacing `/` with `-` in the branch that
    // seeded them (see createWorktreeAt, commands/interactive/worktree.ts),
    // so for that pattern cwd and branch carry the SAME identity string
    // twice — e.g. dir `afk-20260705-142358-47b3ec` vs branch
    // `afk/20260705-142358-47b3ec`. Three conditions must ALL hold before the
    // cwd is suppressed:
    //   1. the cwd's PARENT directory is literally `.afk-worktrees` — a
    //      positive worktree signal. Without it, a plain checkout whose
    //      basename merely coincides with its branch (cwd `/repos/feature-foo`
    //      on branch `feature/foo`) would have its repository path hidden even
    //      though no worktree is involved.
    //   2. the slash-normalized branch equals the cwd basename (the identity
    //      match itself).
    //   3. the branch fits the 30-col cap uncut. When it would truncate,
    //      merging would leave a truncated branch as the SOLE location signal
    //      (cwd is gone), which is strictly worse than the un-deduped line —
    //      so we fall through to the else branch and keep cwd as a second
    //      signal.
    // Comparison runs on EVERY repaint (uncached, not memoized): cwd is fixed
    // per-session but the branch comes from GitStatusSampler, an async
    // sampler whose cached value can change mid-session (e.g. a manual
    // checkout inside the worktree), so a cached compare could go stale.
    // Uses the RAW cwd (f.cwd is the unformatted session cwd — formatCwd()
    // only shortens it below, for display), not the tildified/collapsed
    // formatCwd() output, so display shortening never breaks the match.
    const worktreeDedupe =
      f.cwd !== undefined &&
      f.branch !== undefined &&
      basename(dirname(f.cwd)) === '.afk-worktrees' &&
      f.branch.replaceAll('/', '-') === basename(f.cwd) &&
      displayWidth(f.branch) <= 30;

    if (worktreeDedupe) {
      // Matched: cwd is pure duplication of the branch identity, so it's
      // omitted entirely and the branch segment (+ PR suffix) alone carries
      // "where am I?". It takes droppablePriority 1 — drop-LAST among
      // droppables, identical to the plain branch in the else-branch — and is
      // deliberately NOT never-drop: the model is the never-drop identity the
      // top-of-method invariant protects, and a never-drop location here would
      // stack with the never-drop model and blow maxW on a narrow terminal,
      // forcing the final blind truncation to shear the model off the right
      // edge. Drop-last means the location sheds before the model is ever cut.
      const branchText = truncateDisplayWidth(f.branch!, 30);
      let gitText = `${palette.dim('⎇')} ${palette.dim(branchText)}`;
      if (f.pr !== undefined) gitText += ` ${palette.meta(`#${f.pr}`)}`;
      parts.push({ text: gitText, droppablePriority: 1 }); // drop last among droppables — matches the plain branch; keeps the model never-drop
    } else {
      // Cwd leads the line so it survives right-edge truncation. Cap its share
      // of the budget at ~40% so a deep path can't shove the model/cost/context
      // pieces off the right edge before the truncator ever sees them.
      if (f.cwd) {
        const cwdBudget = Math.max(8, Math.floor(maxW * 0.4));
        const formatted = formatCwd(f.cwd, { maxWidth: cwdBudget });
        if (formatted) parts.push({ text: palette.dim(formatted) }); // never drop
      }

      // Git branch (+ open PR) sits next to the cwd — both answer "where am I?".
      // The branch name is capped at 30 cols so a long branch can't dominate the
      // line; the whole segment is droppable (lowest priority ⇒ dropped last).
      if (f.branch) {
        const branchText = truncateDisplayWidth(f.branch, 30);
        let gitText = `${palette.dim('⎇')} ${palette.dim(branchText)}`;
        if (f.pr !== undefined) gitText += ` ${palette.meta(`#${f.pr}`)}`;
        parts.push({ text: gitText, droppablePriority: 1 }); // drop last among droppables
      }
    }

    // Trusted-skill in-flight indicator no longer renders on the status line;
    // it is emitted inline via completionWriter (see bootstrap.ts).
    parts.push({ text: palette.brand(f.model) }); // never drop

    if (f.permissionMode === 'plan') {
      parts.push({ text: palette.warning('● plan') }); // never drop
    } else if (f.permissionMode === 'autonomous') {
      parts.push({ text: palette.info('◐ AFK') }); // never drop
    } else if (f.permissionMode === 'bypassPermissions') {
      parts.push({ text: palette.bypass('⚡ bypass') }); // never drop
    } else if (f.permissionMode === 'default') {
      // Positive "contained" indicator. Without this, default rendered NO chip
      // (absence = contained), so cycling back from bypass/plan to default just
      // dropped the badge with no affirmative "you're locked down" signal —
      // exactly the gap flagged when `/bypass` was removed in favor of the
      // Shift+Tab cycle. Now every mode has a visible chip.
      parts.push({ text: palette.success('○ default') }); // never drop
    }

    if (f.contextPct !== undefined) {
      const barOutput = formatContextBar({
        ratio: f.contextPct,
        used: f.contextUsedTokens,
        limit: f.contextLimit,
        sparkline: f.contextSparkline,
        width: maxW,
      });
      parts.push({ text: barOutput, droppablePriority: 2 }); // drop 3rd (after cost, before branch)
    }

    if (f.cost !== undefined) {
      parts.push({ text: palette.meta(`$${f.cost.toFixed(2)}`), droppablePriority: 3 }); // drop 2nd
    }

    if (f.tokens !== undefined) {
      parts.push({ text: palette.meta(`${formatTokens(f.tokens)} tok`), droppablePriority: 4 }); // drop 1st
    }

    // Join with separator and measure the result.
    const separator = palette.dim(' · ');
    let joined = parts.map((p) => p.text).join(separator);

    // If the line fits within maxW, return as-is.
    if (displayWidth(joined) <= maxW) {
      return joined;
    }

    // Line is too wide: drop lower-priority (higher number) droppable fields,
    // highest priority (highest droppablePriority number) first, until it fits
    // or only non-droppable fields remain.
    let droppable = parts.filter((p) => p.droppablePriority !== undefined);
    while (droppable.length > 0 && displayWidth(joined) > maxW) {
      // Find the droppable with the highest droppablePriority (drop-first candidate).
      const maxPriority = Math.max(...droppable.map((p) => p.droppablePriority!));
      parts = parts.filter((p) => p.droppablePriority === undefined || p.droppablePriority !== maxPriority);
      joined = parts.map((p) => p.text).join(separator);
      droppable = parts.filter((p) => p.droppablePriority !== undefined);
    }

    // If still too wide after dropping all droppables, fall back to truncate.
    return truncateDisplayWidth(joined, maxW);
  }

  private currentRows(): number {
    const rows = this.stream.rows;
    return typeof rows === 'number' && rows > 0 ? rows : 24;
  }

  private paintRow(rows: number): number {
    return rows > 1 ? rows : 1;
  }

  private writeScrollRegion(rows: number): void {
    const reserved = 1 + this.extraRows;
    if (rows > reserved) {
      this.stream.write(`\x1b[1;${rows - reserved}r`);
      return;
    }
    this.stream.write('\x1b[r');
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
