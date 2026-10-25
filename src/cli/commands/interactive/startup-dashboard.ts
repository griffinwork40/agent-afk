/**
 * Startup dashboard — compact ambient block rendered at REPL boot.
 *
 * Returns 0, 1, or 2 dim lines summarising things that matter right now:
 *   Line 1 — local state: stale worktrees + live peer sessions
 *   Line 2 — daemon state: enabled scheduled tasks
 *
 * Each line self-omits when it has nothing to report. The block appears in
 * the pre-arm banner after the boot-prune notice and after the recall line;
 * the caller is responsible for positioning — this module only returns the
 * formatted strings.
 *
 * Contract: all data-source reads are wrapped in try/catch. A failure in any
 * source silently omits that item; it never throws and never crashes bootstrap.
 */

import { palette } from '../../palette.js';
import { readLivePresenceFiles } from '../../../agent/awareness/presence.js';
import { loadSchedules } from '../../../agent/daemon/schedule-store.js';

export interface StartupDashboardOpts {
  isTTY: boolean;
  isFirstRun: boolean;
  /** Count of stale worktrees already computed during boot-prune. */
  bootPruneStaleCount?: number;
}

/**
 * Render the startup dashboard block.
 *
 * Returns an array of formatted, palette-dimmed lines ready to print.
 * Returns `[]` when suppressed (non-TTY, first run, or nothing to show).
 */
export async function renderStartupDashboard(
  opts: StartupDashboardOpts,
): Promise<string[]> {
  if (!opts.isTTY || opts.isFirstRun) return [];

  const lines: string[] = [];

  // -- Line 1: local state (stale worktrees + live peers) ------------------
  const localItems: string[] = [];

  const stale = opts.bootPruneStaleCount ?? 0;
  if (stale > 0) {
    localItems.push(`${stale} stale worktree${stale === 1 ? '' : 's'}`);
  }

  try {
    const presence = await readLivePresenceFiles();
    const peers = presence.filter((r) => r.surface === 'cli');
    if (peers.length > 0) {
      localItems.push(`${peers.length} peer${peers.length === 1 ? '' : 's'} live`);
    }
  } catch {
    // Presence read failed — omit silently. Bootstrap must not be blocked.
  }

  if (localItems.length > 0) {
    lines.push(palette.dim(`  ◈ ${localItems.join(' · ')}`));
  }

  // -- Line 2: daemon state (scheduled tasks) -------------------------------
  const daemonItems: string[] = [];

  try {
    const schedules = loadSchedules();
    const enabled = schedules.filter((s) => s.enabled);
    if (enabled.length > 0) {
      daemonItems.push(
        `${enabled.length} scheduled task${enabled.length === 1 ? '' : 's'}`,
      );
    }
  } catch {
    // Schedule read failed — omit silently.
  }

  if (daemonItems.length > 0) {
    lines.push(palette.dim(`  ◈ ${daemonItems.join(' · ')}`));
  }

  return lines;
}
