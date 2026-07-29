/**
 * Process-level cleanup registry for presence-file lifecycle.
 *
 * `presence-lifecycle.ts` previously registered its OWN `process.once('exit'|
 * 'SIGINT'|'SIGTERM')` handlers on every presence write, which is wrong on two
 * independent axes:
 *
 *   (a) Every surface that owns a graceful shutdown (`telegram/bot.ts`,
 *       `cli/commands/daemon.ts`, `cli/commands/interactive.ts`) installs its
 *       OWN SIGINT/SIGTERM listener at startup — before a session ever reaches
 *       its first `query()` call, so before presence's handler existed. Node
 *       invokes same-event listeners in registration order, so the surface's
 *       handler ran first, kicked off its (async) shutdown, and returned
 *       control at its first `await` — at which point presence's
 *       later-registered handler ran SYNCHRONOUSLY, in the same signal-
 *       delivery tick, and called `process.exit()` before the surface's
 *       Telegraf drain / `handle.stop()` / `runCleanupFunctions()` ever got a
 *       turn on the event loop. That both abandoned the graceful shutdown and
 *       changed the exit code (0 → 130/143) under a supervisor.
 *   (b) One process can legitimately host N top-level sessions (daemon tasks,
 *       parallel farm workers), and registering 3 listeners per session leaks
 *       3N listeners — observed as 36 listeners + `MaxListenersExceededWarning`
 *       for 12 daemon tasks.
 *
 * This module fixes both: a single module-level id set, and exactly ONE
 * `process.on(...)` install per process (idempotent — later calls are no-ops).
 *
 * @module agent/providers/shared/presence-signals
 */

import { removePresenceFileSync } from '../../awareness/index.js';

/** Live presence session ids awaiting cleanup on process exit/signal. */
const liveSessionIds = new Set<string>();

/** Whether the process-level listeners have been installed (idempotent gate). */
let installed = false;

// Handler references, retained so `_resetPresenceSignalsForTest` can remove
// exactly the listeners this module attached (never a caller's own).
let onExit: (() => void) | null = null;
let onSigint: (() => void) | null = null;
let onSigterm: (() => void) | null = null;

function removeAllTracked(): void {
  for (const id of liveSessionIds) removePresenceFileSync(id);
}

/**
 * Lazily install the process-level `exit`/`SIGINT`/`SIGTERM` listeners.
 * Idempotent — a no-op after the first call, regardless of how many sessions
 * register (fixes defect (b) above).
 *
 * Invariant: Node suppresses its default terminate-on-signal action the
 * moment ANY listener is attached to `SIGINT`/`SIGTERM` — there is no way to
 * "not handle" the signal once `.on()` has been called once by anyone in the
 * process. So this handler's own `process.exit(code)` call must be
 * conditional: fire it only when NO OTHER listener owned the signal at
 * install time (captured via `process.listenerCount(sig) === 0` BEFORE this
 * module attaches its own listener). A surface with no handler of its own
 * (`afk chat`, one-shot) would otherwise hang forever on Ctrl+C — nothing else
 * would ever call `process.exit`. A surface that DOES install its own handler
 * (telegram/bot.ts, daemon.ts, interactive.ts — all registered at startup,
 * i.e. before this lazy install ever runs) owns the exit call at the END of
 * its own async shutdown; this module exiting unconditionally would truncate
 * that shutdown (defect (a) above). Removing the presence file(s) is safe
 * either way and always runs first — it is synchronous and idempotent.
 */
function ensureInstalled(): void {
  if (installed) return;
  installed = true;

  onExit = () => removeAllTracked();
  process.on('exit', onExit);

  const sigintOwnedElsewhere = process.listenerCount('SIGINT') > 0;
  onSigint = () => {
    removeAllTracked();
    if (!sigintOwnedElsewhere) process.exit(130);
  };
  process.on('SIGINT', onSigint);

  const sigtermOwnedElsewhere = process.listenerCount('SIGTERM') > 0;
  onSigterm = () => {
    removeAllTracked();
    if (!sigtermOwnedElsewhere) process.exit(143);
  };
  process.on('SIGTERM', onSigterm);
}

/**
 * Register a session id for presence-file cleanup on process exit/signal.
 * Installs the process-level listeners on first call (see {@link ensureInstalled}).
 */
export function registerPresenceCleanup(sessionId: string): void {
  ensureInstalled();
  liveSessionIds.add(sessionId);
}

/**
 * Stop tracking a session id — its presence file is no longer removed on
 * process exit/signal. Used when a session's advertised id changes (a new
 * cleanup registration for the new id normally accompanies this) or when a
 * session ends and its presence file has already been removed explicitly.
 */
export function unregisterPresenceCleanup(sessionId: string): void {
  liveSessionIds.delete(sessionId);
}

/**
 * Test-only reset: removes this module's own listeners and clears all
 * tracked state, so the next `registerPresenceCleanup` call reinstalls fresh
 * listeners instead of silently no-oping against a previous test's state.
 * Never call from production code.
 */
export function _resetPresenceSignalsForTest(): void {
  if (onExit) process.removeListener('exit', onExit);
  if (onSigint) process.removeListener('SIGINT', onSigint);
  if (onSigterm) process.removeListener('SIGTERM', onSigterm);
  onExit = null;
  onSigint = null;
  onSigterm = null;
  installed = false;
  liveSessionIds.clear();
}
