/**
 * Foreground-only subagent count accessor for the health rail.
 *
 * Background dispatches travel through the same `SubagentManager.forkSubagent()`
 * path as foreground dispatches. This means their handles are present in
 * `SubagentManager.list()` while they are running AND tracked separately in
 * `BackgroundAgentRegistry`. To avoid double-counting when the health rail adds
 * the foreground and background totals together, this module excludes
 * background-registered handles from the foreground count.
 *
 * @module cli/commands/interactive/foreground-counts
 */


/**
 * Minimal shape accepted from `SubagentManager` — isolates the dependency so
 * tests can mock it without importing the full manager.
 */
export interface FgCountsManagerSlice {
  /** Returns all currently in-flight subagent handles (foreground + background). */
  list(): Array<{ id: string; status: string }>;
  /** Monotonically-increasing total dispatches ever made by this manager. */
  readonly dispatchCount: number;
}

/**
 * Minimal shape accepted from `BackgroundAgentRegistry` — only the fields
 * needed to exclude background-owned handles.
 */
export interface FgCountsRegistrySlice {
  /** Returns all registered background jobs (running + recently-settled). */
  list(): ReadonlyArray<{ subagentId: string }>;
}

/**
 * Create a stateful getter that returns foreground-only subagent counts.
 *
 * The returned function is called on every `HealthRail.update()` tick. It:
 *
 * 1. Queries the background registry for currently-known background jobs.
 * 2. Ratchets `bgSeenMax` so the foreground total does not inflate when the
 *    registry evicts terminal jobs (~5 min after they settle).
 * 3. Excludes background-registered handles from the active-foreground count
 *    by comparing handle ids against the registry's `subagentId` set.
 * 4. Computes the foreground-only total as `dispatchCount − bgSeenMax`.
 *
 * **Why ratchet?** `BackgroundAgentRegistry.list()` can shrink as terminal
 * jobs are evicted. Without the ratchet, the foreground total would inflate
 * (dispatchCount stays fixed; bgSeenMax would shrink). The ratchet ensures
 * the foreground total is monotonically non-decreasing, matching the ratchet
 * contract on `HealthRail`'s `totalBgSubsEver` and `totalFgSubsEver`.
 *
 * @param manager  Root `SubagentManager` (or a compatible slice for tests).
 * @param registry `BackgroundAgentRegistry` (or a compatible slice for tests).
 *   Pass `undefined` when no registry is wired — foreground total equals
 *   `dispatchCount` (no background dispatches exist to subtract).
 */
export function makeForegroundCountsGetter(
  manager: FgCountsManagerSlice,
  registry: FgCountsRegistrySlice | undefined,
): () => { active: number; total: number } {
  /** Ratchet: highest number of background jobs ever seen from the registry. */
  let bgSeenMax = 0;

  return (): { active: number; total: number } => {
    const bgJobs = registry?.list() ?? [];
    // Use Set size so duplicate registry entries (same subagentId) do not
    // permanently deflate the foreground total by ratcheting a count > unique bg dispatches.
    const bgSubagentIds = new Set(bgJobs.map((j) => j.subagentId));
    bgSeenMax = Math.max(bgSeenMax, bgSubagentIds.size);

    const handles = manager.list();
    const active = handles.filter(
      (h) => h.status === 'running' && !bgSubagentIds.has(h.id),
    ).length;
    const total = Math.max(0, manager.dispatchCount - bgSeenMax);
    return { active, total };
  };
}
