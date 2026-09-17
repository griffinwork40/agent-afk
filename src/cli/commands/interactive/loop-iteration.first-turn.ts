/**
 * First-turn hook runner — extracted from `loop-iteration.ts` to keep that
 * file within the code-line ceiling.
 *
 * Fires the session's `firstTurnHook` exactly once (before the first turn)
 * and swallows errors so the REPL is never broken by a misbehaving hook.
 */

import type { InteractiveCtx } from './shared.js';
import { palette } from '../../palette.js';

/**
 * Run the session's first-turn hook if one is registered and this is the
 * first turn. Single-fire: the hook ref is cleared before awaiting so a
 * slow hook cannot re-fire if the loop is re-entered mid-await.
 *
 * Must be called before `runTurn` (and before plugin preflights) so
 * worktree-creating hooks run before any cwd-sensitive operations.
 */
export async function runFirstTurnHookIfNeeded(ctx: InteractiveCtx, text: string): Promise<void> {
  if (ctx.firstTurnHook && ctx.stats.totalTurns === 0) {
    const hook = ctx.firstTurnHook;
    ctx.firstTurnHook = undefined;
    try {
      await hook(text);
    } catch (err) {
      ctx.completionWriter.fn(
        palette.warning('⚠ ') + 'first-turn hook failed: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
