/**
 * /name [name] — show or set this session's human-readable name.
 *
 * With no argument: prints the current name (or a hint when unset).
 * With an argument: slugifies it, sets `stats.name`, and — once the session
 * has turns — persists immediately so `/resume` and `--resume <name>` can find
 * it by name instead of a UUID. The name is metadata on the single
 * <sessionId>.json sidecar; setting it never creates a duplicate file.
 *
 * This is the rename command: it sets the session name and persists it once
 * the session has turns. It also calls `peerNotifier.setName` so that the
 * live presence file is updated immediately (peer discovery shows the new
 * label without waiting for the next heartbeat).
 */

import { palette } from '../../palette.js';
import { setSessionName } from '../../../agent/session-control/index.js';
import { formatResumeCommand } from '../../resume-command.js';
import type { SlashCommand } from '../types.js';
import { errorMessage } from '../../../utils/errors.js';
import type { PeerInboxNotifier } from '../../commands/interactive/peer-inbox-notifier.js';

let peerNotifierRef: PeerInboxNotifier | undefined;

/**
 * Wire the REPL's PeerInboxNotifier so `/name` can update the presence label
 * immediately via `setName`. Mirrors the `setShellPassthrough` pattern used
 * by `/sh`. Called from `setupFooterSubsystems` after `createReplPeerNotifier`.
 */
export function setNamePeerNotifier(notifier: PeerInboxNotifier): void {
  peerNotifierRef = notifier;
}

export const nameCmd: SlashCommand = {
  name: '/name',
  usage: '/name [name]',
  hint: 'When you want a memorable handle for this session so /resume and --resume can find it by name instead of a UUID.',
  summary: 'Show or set this session’s name',
  async handler(ctx, args) {
    const raw = args.trim();

    // No arg → report the current name.
    if (!raw) {
      if (ctx.stats.name) {
        const hostConsole = ctx.capabilities === undefined || ctx.capabilities.has('consoleOutput');
        const shown = hostConsole ? ctx.stats.name : (ctx.stats.displayName ?? ctx.stats.name);
        ctx.out.line(palette.dim('  name  ') + palette.warning(shown));
      } else {
        ctx.out.info('No name set. Use /name <name> to set one.');
      }
      return 'continue';
    }

    const result = setSessionName(ctx.stats, raw, {
      onName: (name) => { void peerNotifierRef?.setName(name); },
    });
    if (!result.ok) {
      ctx.out.warn('Invalid name — use letters, numbers, spaces, or hyphens.');
      return 'continue';
    }

    // Invariant: REPL output is byte-identical to before (slug + resume hint).
    // The `afk interactive --resume` hint is a host-shell command, so only a
    // surface attached to the host console (capability `consoleOutput`; legacy
    // contexts without capabilities count as the REPL) prints it. Other
    // surfaces (web, Telegram) echo the name as typed instead of the slug.
    const hostConsole = ctx.capabilities === undefined || ctx.capabilities.has('consoleOutput');
    const slug = result.name;
    const shown = hostConsole ? slug : (ctx.stats.displayName ?? slug);
    if ('saveError' in result) {
      ctx.out.error(`Named "${shown}" but save failed: ${errorMessage(result.saveError)}`);
    } else if (result.saved) {
      ctx.out.success(palette.success('Named') + palette.dim(`  ${shown}`));
      if (hostConsole) ctx.out.line(palette.dim(`  Resume:  ${formatResumeCommand(slug, ctx.stats.model)}`));
    } else {
      ctx.out.success(palette.success('Named') + palette.dim(`  ${shown}  (saves on first turn)`));
    }
    return 'continue';
  },
};
