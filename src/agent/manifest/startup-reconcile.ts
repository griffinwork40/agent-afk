/**
 * Session-startup wave manifest reconciliation helper.
 *
 * Provides a single fire-and-forget entry point (`runStartupReconcile`) that
 * each bootstrap path (REPL, Telegram, daemon, one-shot chat) calls after the
 * session ID is known.  The function:
 *   1. Guards on `shouldSurfaceResumptionOffer(isInteractive)`.
 *   2. Calls `reconcileWaveManifests({ sessionId })`.
 *   3. Emits each offer via `outputOffer` (stderr for CLI, message for Telegram).
 *   4. Never throws — startup must not fail because of reconciliation.
 *
 * Callers pass an `outputOffer` callback so this module stays surface-agnostic
 * (no direct `process.stderr` or Telegram API coupling here).
 *
 * @module agent/manifest/startup-reconcile
 */

import {
  reconcileWaveManifests,
  shouldSurfaceResumptionOffer,
  formatResumptionOffer,
} from './reconcile.js';
import type { StaleManifestOffer } from './reconcile.js';

export interface StartupReconcileOpts {
  /** The session id assigned to this session — needed for `isOwnSession` matching. */
  sessionId: string;
  /**
   * Whether this is an interactive surface (REPL, Telegram).
   * Non-interactive surfaces (daemon, one-shot chat) only surface offers when
   * `AFK_WAVE_RESUME_UNATTENDED=1` is set.
   */
  isInteractive: boolean;
  /**
   * Callback that receives each formatted offer string.
   * Called once per offer that has at least one resumable or blocked unit.
   * The callback itself must not throw (wrap it if needed).
   */
  outputOffer: (text: string) => void;
}

/**
 * Fire-and-forget session-start reconciler.
 *
 * Checks for stale wave manifests after the session ID is known and surfaces
 * resumption offers via `opts.outputOffer`.  Returns without awaiting —
 * callers should NOT await the returned Promise: it always resolves
 * (never rejects) so it is safe to `void` or `.catch(() => {})`.
 *
 * Design invariants (inherited from `reconcileWaveManifests`):
 *   - Expired manifests are deleted on every pass.
 *   - Non-interactive surfaces skip unless `AFK_WAVE_RESUME_UNATTENDED=1`.
 *   - Errors are swallowed; the reconciler is best-effort.
 */
export function runStartupReconcile(opts: StartupReconcileOpts): void {
  if (!shouldSurfaceResumptionOffer(opts.isInteractive)) return;

  // Synchronous reconciler — no async I/O, so no Promise needed.
  // Wrapped in try/catch as an extra safety net beyond the reconciler's own guard.
  try {
    const result = reconcileWaveManifests({ sessionId: opts.sessionId });
    for (const offer of result.offers) {
      try {
        opts.outputOffer(formatResumptionOffer(offer));
      } catch {
        // Never let an outputOffer callback failure break startup.
      }
    }
  } catch {
    // Fire-and-forget: never propagate reconciler errors to the caller.
  }
}

// Re-export the guard for tests that want to verify the shouldSurface logic.
export { shouldSurfaceResumptionOffer };
export type { StaleManifestOffer };
