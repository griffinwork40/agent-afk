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
 */
export function runTelegramReconcile<Route>(
  sessionId: string,
  route: Route,
  sendText: (route: Route, text: string) => void,
): void {
  if (!shouldSurfaceResumptionOffer(true)) return;
  void Promise.resolve().then(() => {
    try {
      const result = reconcileWaveManifests({ sessionId });
      for (const offer of result.offers) {
        sendText(route, formatResumptionOffer(offer));
        markManifestOffered(offer.manifest);
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
