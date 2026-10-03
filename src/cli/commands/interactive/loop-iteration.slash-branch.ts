/**
 * Slash-command dispatch and plugin-skill preflight — two adjacent concerns
 * in the main REPL input loop extracted here so adding new slash kinds or
 * preflight strategies never grows the grandfathered `runInputLoop`.
 *
 * Sequencing invariant: `handleSlashCommand` runs first; if it returns a
 * non-`fall-through` action the caller never reaches `runPluginPreflight`.
 * Only the `fall-through` action (plugin forward) reaches preflight.
 *
 * @module cli/commands/interactive/loop-iteration.slash-branch
 */

import type { ImageAttachment } from '../../input/attachments.js';
import { dispatch as dispatchSlash, parse as parseSlash } from '../../slash/registry.js';
import {
  getPreflight,
  getSkillPreflightDir,
  runPreflight,
  stitchForwardManifest,
  type SkillInvocation,
} from '../../slash/preflight/index.js';
import { isDebugEnabled, debugLog } from '../../../utils/debug.js';
import { palette } from '../../palette.js';
import { errorMessage } from '../../../utils/errors.js';
import type { InteractiveCtx } from './shared.js';
import type { TranscriptHandle } from './transcript.js';
import type { VerdictLedger } from './verdict-ledger.js';

/**
 * Result of processing a slash command.
 *
 * - `action: 'exit'`         — `/exit` was issued; caller should tear down.
 * - `action: 'continue'`     — command was handled; caller should `continue` to next iteration.
 * - `action: 'submit'`       — handler returned a follow-up message; caller seeds it.
 * - `action: 'prefill'`      — rewind; caller pre-fills the next readline buffer.
 * - `action: 'fall-through'` — not a native slash command; plugin-forward path.
 * - `message`                — the follow-up text (submit/prefill only).
 */
export type SlashBranchAction =
  | { action: 'exit' }
  | { action: 'continue' }
  | { action: 'submit'; message: string }
  | { action: 'prefill'; message: string }
  | { action: 'fall-through' };

/**
 * Dispatch a slash command and return the appropriate caller action.
 *
 * Handles `/clear` rotation, verdict-ledger reset, and Stop-injection
 * clear inline (these are single-line side-effects scoped to the dispatch
 * result — moving them into the caller would split the contract).
 *
 * @param text               The raw input line (starts with `/`).
 * @param attachments        Attachments from the current readline result.
 * @param ctx                Interactive session context.
 * @param transcript         Transcript handle (used by `/clear` rotation).
 * @param verdictLedger      Verdict ledger (reset on `/clear`).
 * @param clearStopInjection Side-effect: clear pendingStopInjection on `/clear`.
 */
export async function handleSlashCommand(
  text: string,
  attachments: readonly ImageAttachment[],
  ctx: InteractiveCtx,
  transcript: TranscriptHandle,
  verdictLedger: VerdictLedger,
  clearStopInjection: () => void,
): Promise<SlashBranchAction> {
  const res = await dispatchSlash(text, ctx.slashCtx, attachments);
  if (!res.handled) return { action: 'fall-through' };

  if (res.result === 'exit') {
    // Readline/compositor teardown makes prompting impossible, so the
    // external input-lifecycle constraint requires disposition first.
    await ctx.resolveWorktreeDisposition?.(true);
    ctx.rl.close();
    return { action: 'exit' };
  }

  if (text === '/clear' || text.startsWith('/clear ')) {
    await transcript.rotateOnClear();
    ctx.replRenderer.writeLine(palette.dim(`  transcript: ${transcript.path()}`));
    // The conversation has been wiped — its verdict trajectory is no longer
    // meaningful. Drop the ledger and any pending Stop correction so neither
    // leaks into the fresh session.
    verdictLedger.reset();
    clearStopInjection();
  }

  if (res.result !== null && typeof res.result === 'object' && 'kind' in res.result) {
    if (res.result.kind === 'submit') {
      ctx.statusLine.rearm();
      return { action: 'submit', message: res.result.message };
    }
    if (res.result.kind === 'prefill') {
      ctx.statusLine.rearm();
      return { action: 'prefill', message: res.result.message };
    }
  }

  ctx.statusLine.rearm();
  return { action: 'continue' };
}

/**
 * Run the plugin-skill preflight for a plugin-forward slash command and
 * return the stitched `runText` (manifest prepended when available).
 *
 * Failure-isolated: no preflight registered, preflight returns null, or
 * preflight throws → `text` is returned verbatim (same as today's no-op
 * path). In debug mode, preflight errors are surfaced as warnings.
 *
 * @param text  The raw input text (e.g. `/mint --flag`).
 * @param ctx   Interactive session context.
 * @returns     `text` with any manifest prepended, or `text` unchanged.
 */
export async function runPluginPreflight(text: string, ctx: InteractiveCtx): Promise<string> {
  const parsed = parseSlash(text);
  if (!parsed) return text;

  // Strip leading '/' and any '<plugin>:' namespace → bare name.
  const bare = parsed.name.replace(/^\//, '').split(':').pop() ?? '';
  if (!bare || !getPreflight(bare)) return text;

  const inv: SkillInvocation = {
    skillName: bare,
    rawArgs: parsed.args,
    // Forward path is plugin-only today — user/project slash commands are
    // handled before this block and never reach the preflight path.
    source: 'plugin',
    capabilities: { compose: true, subagents: true },
  };
  const sessionIdMaybe = ctx.session.current.sessionId;
  const artifactDir = getSkillPreflightDir(sessionIdMaybe);

  const preflightStart = Date.now();
  debugLog(`[afk trace] preflight.start commandName=${bare}`);
  let preflightSuccess = false;
  const pre = await runPreflight(
    inv,
    { cwd: ctx.stats.cwd ?? process.cwd(), artifactDir },
    (err) => {
      if (isDebugEnabled()) {
        ctx.replRenderer.writeLine(
          palette.warning(`⚠ preflight(${bare}) failed: `) + errorMessage(err),
        );
      }
    },
  );
  preflightSuccess = pre !== null;
  debugLog(
    `[afk trace] preflight.end commandName=${bare} durationMs=${Date.now() - preflightStart} success=${preflightSuccess}`,
  );
  return stitchForwardManifest(pre?.manifestBlock, text);
}
