/**
 * Surface eligibility check for desktop tools (Tranche 2).
 *
 * Desktop tools require a live desktop belonging to the operator running the
 * session. They must be refused on surfaces where no desktop is accessible:
 * daemon/cron/scheduled tasks (headless server processes) and telegram (the
 * desktop belongs to a different machine than the one the bot runs on).
 * Forked subagents are already excluded from the child tool allowlist by
 * `nesting.ts`, but the check here adds belt-and-suspenders coverage.
 *
 * AFK_DESKTOP_ENABLED is the operator's consent signal — no per-call approval
 * gate is added here. This module only refuses calls on surfaces where the
 * desktop tools cannot meaningfully execute.
 *
 * Allowed: `cli`, `repl`, `acp`, `web`, `sdk`, `unknown`
 * Refused: `daemon`, `telegram`, `subagent`
 *
 * `unknown` is allowed rather than refused because an SDK embedder or custom
 * surface has the operator at the machine; refusing unknown would break
 * legitimate programmatic use. `subagent` is refused as belt-and-suspenders.
 *
 * @module agent/tools/desktop-surface-eligibility
 */

/** Surfaces on which desktop tools must be refused. */
export const DESKTOP_INELIGIBLE_SURFACES: ReadonlySet<string> = new Set([
  'daemon',
  'telegram',
  'subagent',
]);

/**
 * Check whether the given session surface is eligible to run desktop tools.
 *
 * Returns `null` when the surface is eligible (the caller may proceed).
 * Returns a human-readable error string when ineligible (the caller must
 * return this as `{ isError: true, content: <string> }`).
 *
 * @param surface  The session surface string (from `DesktopHandlerOptions` or
 *                 `BuildDispatcherDeps`). `undefined` is treated as eligible —
 *                 callers that have not been updated yet keep their existing
 *                 behavior rather than being silently refused.
 */
export function checkDesktopSurfaceEligibility(
  surface: string | undefined,
): string | null {
  if (surface === undefined) return null;
  if (!DESKTOP_INELIGIBLE_SURFACES.has(surface)) return null;
  return desktopSurfaceRefusalMessage(surface);
}

/**
 * Build the refusal message for an ineligible surface.
 * Exported for test assertions.
 */
export function desktopSurfaceRefusalMessage(surface: string): string {
  if (surface === 'daemon' || surface === 'subagent') {
    return (
      `desktop_screenshot is not available on the "${surface}" surface: ` +
      `no interactive desktop is accessible from a headless session. ` +
      `Desktop tools require an interactive session (cli/repl/acp) where ` +
      `the operator is present at the machine.`
    );
  }
  if (surface === 'telegram') {
    return (
      `desktop_screenshot is not available on the "telegram" surface: ` +
      `the bot process runs on a server and cannot access the operator's ` +
      `desktop. Use an interactive session (cli/repl/acp) instead.`
    );
  }
  // Generic fallback for any future ineligible surface added to the set.
  return (
    `desktop_screenshot is not available on the "${surface}" surface. ` +
    `Desktop tools require an interactive session where the operator's ` +
    `desktop is accessible.`
  );
}
