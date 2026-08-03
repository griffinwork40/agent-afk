import type { SlashContext } from '../../slash/types.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { SessionStats } from '../../slash/types.js';
import type { StatusLine } from '../../status-line.js';
import type { ContextSampler } from '../../context-sampler.js';
import type { GitStatusSampler } from '../../git-status-sampler.js';
import type { TrustedSkillLedger } from '../../trusted-skill-ledger.js';
import type { McpManager } from '../../../agent/mcp/index.js';
import type { createConsoleWriter } from '../../slash/writer.js';
import { formatStatusFields } from './shared.js';

/**
 * Assemble the `SlashContext` every slash command dispatches through.
 *
 * Ordered-operation invariant (governed comment moved verbatim): `ui.clearScreen`
 * resets the persistent compositor's overlay AND committed band BEFORE the
 * physical clear. At idle the overlay still holds the prior turn's composed
 * slots (stage-rail / progress-banner / live-thinking) because borrow-dispose
 * re-composes via overlayComposer.flush() rather than setOverlay('') (see
 * stream-renderer.ts), and the committed band still retains the prior turn's
 * last above-frame block. Without zeroing both here, the post-clear repaint
 * re-paints stale overlay/band rows onto the freshly-cleared screen — the
 * band leak resurrects the prior transcript when a slash menu opens then
 * collapses (a shrink repaint firing repositionCommittedBand). getCompositor
 * is wired by repl-loop.ts after armCompositor and is reached late-bound at
 * call time; undefined on non-TTY surfaces (daemon/tests) → no-op.
 * setOverlay('') early-returns when the overlay is already empty.
 */
export function createReplSlashContext(a: {
  sessionRef: SessionRef;
  stats: SessionStats;
  writer: ReturnType<typeof createConsoleWriter>;
  statusLine: StatusLine;
  contextSampler: ContextSampler;
  gitStatusSampler: GitStatusSampler;
  ledger: TrustedSkillLedger;
  mcpManager: McpManager | undefined;
}): SlashContext {
  const slashCtx: SlashContext = {
    session: a.sessionRef,
    stats: a.stats,
    out: a.writer,
    ui: {
      clearScreen: () => {
        // Ordered-operation invariant: reset the persistent compositor's
        // overlay AND committed band BEFORE the physical clear. At idle the
        // overlay still holds the prior turn's composed slots (stage-rail /
        // progress-banner / live-thinking) because borrow-dispose re-composes
        // via overlayComposer.flush() rather than setOverlay('') (see
        // stream-renderer.ts), and the committed band still retains the prior
        // turn's last above-frame block. Without zeroing both here, the
        // post-clear repaint re-paints stale overlay/band rows onto the
        // freshly-cleared screen — the band leak resurrects the prior
        // transcript when a slash menu opens then collapses (a shrink repaint
        // firing repositionCommittedBand). getCompositor is wired by
        // repl-loop.ts after armCompositor and is reached late-bound at call
        // time; undefined on non-TTY surfaces (daemon/tests) → no-op.
        // setOverlay('') early-returns when the overlay is already empty.
        const compositor = slashCtx.getCompositor?.();
        compositor?.setOverlay('');
        compositor?.resetCommittedBand();
        a.statusLine.stop();
        a.contextSampler.reset();
        // CSI 3J clears scrollback, 2J clears viewport, H homes cursor.
        process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
        a.statusLine.start();
        // Read contextSampler at call time so any swap-replaced sampler is used.
        a.statusLine.repaint(formatStatusFields(a.stats, a.contextSampler, a.gitStatusSampler));
      },
      // Read contextSampler at call time (not at closure-capture time) so
      // a mid-session swap that calls contextSampler.attach(newSession) is
      // reflected on the next repaint.
      repaintStatusLine: () => a.statusLine.repaint(formatStatusFields(a.stats, a.contextSampler, a.gitStatusSampler)),
    },
    ledger: a.ledger,
    // Expose mcpManager so `/mcp auth complete` can call completeAuth().
    ...(a.mcpManager !== undefined ? { mcpManager: a.mcpManager } : {}),
  };
  return slashCtx;
}
