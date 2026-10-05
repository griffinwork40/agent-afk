/**
 * Session-layer Stop hook wiring for the REPL loop.
 *
 * Extracted from `runInputLoop` to keep that grandfathered function under the
 * 200-line ceiling. The wiring supplies `getHasNextTurn: () => true` (the REPL
 * always has a next prompt) and routes injectContext into
 * `pendingStopInjection`, which the main loop drains at the top of each
 * iteration. Blocked/timeout notices are rendered via `completionWriter`.
 *
 * @module cli/commands/interactive/loop-iteration.stop-wiring
 */

import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { palette } from '../../palette.js';
import type { StopWiring } from '../../../agent/types/session-types.js';
import type { InteractiveCtx } from './shared.js';

/**
 * Build the `StopWiring` object for the REPL surface and perform the initial
 * `wireStopHook` call on the current session.
 *
 * @param ctx                      Interactive session context.
 * @param setPendingStopInjection  Setter for the pending Stop injection slot.
 * @returns The wiring object — the caller must re-apply it via
 *          `ctx.session.current.wireStopHook?.(wiring)` before each turn to
 *          cover sessions swapped by `/resume`.
 */
export function wireReplStopHook(
  ctx: InteractiveCtx,
  setPendingStopInjection: (text: string) => void,
): StopWiring {
  const wiring: StopWiring = {
    getHasNextTurn: () => true,
    onStopInjectContext: setPendingStopInjection,
    onStopBlocked: (reason) => {
      ctx.completionWriter.fn(
        palette.dim(`  [stop hook] blocked: ${sanitizeForDisplay(reason ?? 'no reason given')}`),
      );
    },
    onStopTimeout: () => {
      ctx.completionWriter.fn(palette.dim('  [stop hook] timed out'));
    },
  };
  ctx.session.current.wireStopHook?.(wiring);
  return wiring;
}
