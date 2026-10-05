/**
 * Shell-passthrough branch for the main REPL input loop — handles `!cmd`
 * (foreground) and `!&cmd` (background) input lines. Extracted from
 * `runInputLoop` so the per-branch logic is independently readable and
 * testable without growing that grandfathered function.
 *
 * @module cli/commands/interactive/loop-iteration.shell-branch
 */

import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import type { InteractiveCtx } from './shared.js';
import type { FooterSubsystems } from './footer-subsystems.js';

/**
 * Result of attempting the shell-passthrough branch.
 *
 * `handled` — the input was dispatched as a shell command and the caller
 *   should `continue` to the next loop iteration.
 * `noticeNowPrinted` — the first-use notice was printed during this call;
 *   the caller should persist this into its `shellPassthroughNoticePrinted`
 *   flag so subsequent iterations stay silent.
 */
export interface ShellBranchResult {
  handled: boolean;
  noticeNowPrinted: boolean;
}

/**
 * Handle a `!cmd` input line through the shell-passthrough subsystem.
 *
 * Returns `{ handled: true }` when the line was dispatched as a shell
 * command (caller should `continue`). Returns `{ handled: false }` when
 * shell passthrough is disabled or the dispatcher returned false, meaning
 * the input should fall through to the model as literal text.
 *
 * Emits the first-use notice on the first `!cmd` dispatch in the session
 * when `noticePrinted` is false. The returned `noticeNowPrinted` flag
 * should be OR'd into the caller's tracking variable.
 *
 * @param text          Raw input line (must start with `!`).
 * @param ctx           Interactive session context.
 * @param footer        Footer subsystems (provides `shellPassthrough`).
 * @param noticePrinted Whether the first-use notice was already shown.
 */
export async function handleShellPassthrough(
  text: string,
  ctx: InteractiveCtx,
  footer: FooterSubsystems,
  noticePrinted: boolean,
): Promise<ShellBranchResult> {
  const shellPassthroughEnvOptOut = /^(0|false|off|no)$/i.test(env.AFK_SHELL_PASSTHROUGH ?? '');
  const shellPassthroughEnabled = ctx.options.shellPassthrough !== false && !shellPassthroughEnvOptOut;

  if (!shellPassthroughEnabled) return { handled: false, noticeNowPrinted: false };

  let noticeNowPrinted = false;
  if (!noticePrinted) {
    noticeNowPrinted = true;
    ctx.replRenderer.writeLine(
      palette.dim(
        '  ℹ  ! prefix shells out. Pass --no-shell-passthrough (or set AFK_SHELL_PASSTHROUGH=0) to send ! text to the model instead.',
      ),
    );
  }
  const dispatched = await footer.shellPassthrough.dispatch(text);
  if (dispatched) {
    ctx.statusLine.rearm();
    return { handled: true, noticeNowPrinted };
  }
  // Empty `!` with no body — dispatcher emitted usage hint, fall through.
  return { handled: false, noticeNowPrinted };
}
