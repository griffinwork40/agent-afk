/**
 * /bypass — toggle bypassPermissions mode (DANGEROUS).
 *
 * Usage:
 *   /bypass            — toggle bypass mode on/off
 *   /bypass on         — enter bypass mode
 *   /bypass off        — exit bypass mode
 *
 * Bypass mode is the permission mode `'bypassPermissions'`. It disables the
 * path-approval prompt AND the handler's path-containment check: filesystem
 * tools (read_file/write_file/edit_file/list_directory/glob/grep) may touch ANY
 * path with no confirmation. This is the agent-afk equivalent of Claude Code's
 * `--dangerously-skip-permissions`.
 *
 * It does NOT suppress `ask_question` — that is the model choosing to ask you a
 * substantive question, a different axis from path permission. If you want the
 * agent to ask less, adjust posture in AFK.md, not here.
 *
 * Mutual exclusivity: bypass, AFK (`'autonomous'`), and plan (`'plan'`) share
 * the single `permissionMode` field, so `/bypass on` from any of them replaces
 * the mode. `/bypass off` restores `'default'` (containment + prompts back on).
 *
 * Scope: a REPL affordance. Other surfaces enable bypass via the
 * `--dangerously-skip-permissions` flag or the `permissionMode` config key.
 * The daemon sets it directly (no human to prompt).
 */

import { palette } from '../../palette.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';

const ON_NOTICE =
  palette.bypass('⚡ bypass ON') +
  palette.dim(
    ' — full-power mode: path-approval prompts OFF; the agent can read/write ANY ' +
    'path on this machine with no confirmation. Run /bypass off to restore ' +
    'containment. (Does not affect ask_question.)',
  );

const OFF_NOTICE =
  palette.success('○ bypass OFF') +
  palette.dim(' — default permissions restored (path containment + prompts back on)');

export const bypassCmd: SlashCommand = {
  name: '/bypass',
  usage: '/bypass [on|off]',
  summary: 'Toggle bypass mode — skip path-approval prompts (DANGEROUS: read/write anywhere)',
  hint:
    'Disable path-approval prompts AND path containment for filesystem tools — ' +
    'the agent can touch any path with no confirmation. The agent-afk equivalent ' +
    'of --dangerously-skip-permissions. Does not affect ask_question. /bypass off restores containment.',
  async handler(ctx: SlashContext, args: string): Promise<SlashResult> {
    const argLower = args.trim().toLowerCase();
    const isOn = ctx.stats.permissionMode === 'bypassPermissions';
    const desired =
      argLower === 'on' ? true :
      argLower === 'off' ? false :
      !isOn;

    if (desired && isOn) {
      // Already on — suppress the no-op success line for ergonomics.
      return 'continue';
    }
    if (!desired && !isOn) {
      // Already off — surface the affordance with a no-op toggle.
      ctx.out.success(OFF_NOTICE);
      return 'continue';
    }

    try {
      await ctx.session.current.setPermissionMode(desired ? 'bypassPermissions' : 'default');
      ctx.stats.permissionMode = desired ? 'bypassPermissions' : 'default';
      ctx.ui.repaintStatusLine();
      // ON notice goes through the plain line channel (not error/✗) so it reads
      // as a cool "full-power" badge rather than a red alarm — bypass is the
      // default mode, so the indicator informs without alarming. The dim text
      // still spells out exactly what bypass does, so nothing is hidden.
      if (desired) ctx.out.line(ON_NOTICE);
      else ctx.out.success(OFF_NOTICE);
    } catch (err) {
      ctx.out.error(
        `Could not toggle bypass mode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 'continue';
  },
};
