/**
 * Fire-and-forget wave-manifest reconciliation for session startup paths.
 *
 * Each exported helper wires `reconcileWaveManifests()` into a specific
 * surface's session startup without blocking the caller. Errors are swallowed
 * per the fire-and-forget contract of the reconciler.
 *
 * Surfaces:
 *  - REPL (`runReplReconcile`): always interactive; writes to stderr.
 *  - Telegram (`runTelegramReconcile`): always interactive; forwards via callback.
 *  - Daemon / one-shot chat (`runNonInteractiveReconcile`): gated on
 *    `shouldSurfaceResumptionOffer(false)` (requires AFK_WAVE_RESUME_UNATTENDED=1).
 *
 * @module agent/manifest/startup-reconcile
 */

import { reconcileWaveManifests, formatResumptionOffer, shouldSurfaceResumptionOffer, markManifestOffered } from './reconcile.js';
import { pushIfConfigured } from '../../telegram/push.js';

/**
 * Wire reconciliation for the interactive REPL surface.
 * Fire-and-forget: returns immediately; errors are swallowed.
 */
export function runReplReconcile(sessionId: string): void {
  if (!shouldSurfaceResumptionOffer(true)) return;
  void Promise.resolve().then(() => {
    try {
      const result = reconcileWaveManifests({ sessionId });
      for (const offer of result.offers) {
        process.stderr.write(formatResumptionOffer(offer) + '\n');
        markManifestOffered(offer.manifest);
      }
    } catch {
      // Fire-and-forget: reconciler errors must never surface to the user.
    }
  });
}

/**
 * Wire reconciliation for the Telegram surface.
 * Fire-and-forget: returns immediately; errors are swallowed.
 *
 * @param sessionId - The SDK session ID of the newly created session.
 * @param route     - The Telegram route to deliver the offer to.
 * @param sendText  - Callback that delivers a plain-text message to the route.
 *                    May return a Promise<boolean> where `true` means delivered
 *                    and `false` means failed. A void/undefined return is treated
 *                    as "assumed delivered" (backward compat for REPL/non-interactive
 *                    callers that pass a synchronous void function).
 */
export function runTelegramReconcile<Route>(
  sessionId: string,
  route: Route,
  sendText: (route: Route, text: string) => void | Promise<boolean>,
): void {
  if (!shouldSurfaceResumptionOffer(true)) return;
  void Promise.resolve().then(async () => {
    try {
      const result = reconcileWaveManifests({ sessionId });
      for (const offer of result.offers) {
        const delivered = await Promise.resolve(sendText(route, formatResumptionOffer(offer)));
        // Stamp only when delivery confirmed (true) or unknown (void/undefined = legacy caller).
        // Skip stamp on explicit failure (false) so next session re-surfaces the offer.
        if (delivered !== false) {
          markManifestOffered(offer.manifest);
        }
      }
    } catch {
      // Fire-and-forget: reconciler errors must never surface to the user.
    }
  });
}

/**
 * Wire reconciliation for non-interactive surfaces (daemon, one-shot chat).
 * Gated on `shouldSurfaceResumptionOffer(false)` — requires `AFK_WAVE_RESUME_UNATTENDED=1`.
 * Fire-and-forget: returns immediately; errors are swallowed.
 */
export function runNonInteractiveReconcile(sessionId: string): void {
  if (!shouldSurfaceResumptionOffer(false)) return;
  void Promise.resolve().then(() => {
    try {
      const result = reconcileWaveManifests({ sessionId });
      for (const offer of result.offers) {
        process.stderr.write(formatResumptionOffer(offer) + '\n');
        markManifestOffered(offer.manifest);
      }
    } catch {
      // Fire-and-forget: reconciler errors must never surface to the user.
    }
  });
}

/**
 * Wire reconciliation for the daemon surface with confirmed Telegram delivery.
 *
 * Mirrors `runTelegramReconcile` — pushes each resumption offer via
 * `pushIfConfigured` and only calls `markManifestOffered` when the push
 * succeeds (at least one delivery returned `ok: true`). Falls back to stderr
 * when Telegram is not configured so the offer is never silently lost.
 *
 * Gate: active when `AFK_WAVE_RESUME_UNATTENDED=1` (same as
 * `runNonInteractiveReconcile`). Fire-and-forget: returns immediately; errors
 * are swallowed.
 */
export function runDaemonReconcile(sessionId: string): void {
  if (!shouldSurfaceResumptionOffer(false)) return;
  void Promise.resolve().then(async () => {
    try {
      const result = reconcileWaveManifests({ sessionId });
      for (const offer of result.offers) {
        const text = formatResumptionOffer(offer);
        const results = await pushIfConfigured(text).catch(() => null);
        if (results === null) {
          // Telegram not configured — fall back to stderr so the offer is visible.
          process.stderr.write(text + '\n');
          markManifestOffered(offer.manifest);
        } else {
          // Only stamp as offered when at least one delivery succeeded.
          const delivered = results.some((r) => r.ok);
          if (delivered) markManifestOffered(offer.manifest);
        }
      }
    } catch {
      // Fire-and-forget: reconciler errors must never surface to the user.
    }
  });
}
