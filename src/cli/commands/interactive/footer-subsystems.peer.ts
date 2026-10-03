/**
 * Peer-inbox notifier construction + slash-command wiring for the REPL loop.
 *
 * Extracted from `footer-subsystems.ts` to keep `setupFooterSubsystems`
 * within its baselined function-size ceiling. This sibling owns the seam
 * between the REPL's `PeerInboxNotifier` instance and the singleton injection
 * points used by the `/inbox` and `/name` slash commands.
 *
 * @module cli/commands/interactive/footer-subsystems.peer
 */

import { createReplPeerNotifier, type PeerInboxNotifier } from './peer-inbox-notifier.js';
import { setPeerNotifier } from '../../slash/commands/inbox.js';
import { setNamePeerNotifier } from '../../slash/commands/name.js';
import type { InteractiveCtx } from './shared.js';

/**
 * Construct the REPL peer-inbox notifier, wire it into the `/inbox` and
 * `/name` slash-command singletons, and expose `resetForNewSession` on `ctx`
 * so the `/resume` swap path can clear per-session state synchronously.
 * Mirrors `setShellPassthrough` (used by `/sh`) — each singleton lives in
 * exactly one file for the module-state audit (`pnpm audit:module-state:check`).
 *
 * Returns the notifier so `setupFooterSubsystems` can include it in the
 * `FooterSubsystems` bag without knowing about the wiring details.
 */
export function buildAndWirePeerNotifier(ctx: InteractiveCtx): PeerInboxNotifier {
  const peerNotifier = createReplPeerNotifier(ctx);
  setPeerNotifier(peerNotifier, () => ctx.stats.sessionId);
  setNamePeerNotifier(peerNotifier);
  // Wire the swap reset so bootstrap-resume.ts:clearSwapBuffers() can invoke it.
  ctx.resetPeerNotifier = () => peerNotifier.resetForNewSession();
  return peerNotifier;
}
