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
import { saveSession } from '../../session-store.js';
import { slugifySessionName } from '../../session-name.js';
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
        ctx.out.line(palette.dim('  name  ') + palette.warning(ctx.stats.name));
      } else {
        ctx.out.info('No name set. Use /name <name> to set one.');
      }
      return 'continue';
    }

    const slug = slugifySessionName(raw);
    if (!slug) {
      ctx.out.warn('Invalid name — use letters, numbers, spaces, or hyphens.');
      return 'continue';
    }

    ctx.stats.name = slug;

    // Propagate the new name to the peer-presence file so peer discovery
    // (list_sessions, /peers) shows the updated label immediately. Fire-and-
    // forget: the presence write is best-effort and must not block the REPL.
    void peerNotifierRef?.setName(slug);

    // Persist now if there's something to save; otherwise the name rides
    // along on the first per-turn autosave. saveSession keys on sessionId,
    // not the name, so no duplicate sidecar is created.
    if (ctx.stats.totalTurns > 0) {
      try {
        // Mid-session rename: no closeTime.
        saveSession(ctx.stats);
        ctx.out.success(palette.success('Named') + palette.dim(`  ${slug}`));
        ctx.out.line(palette.dim(`  Resume:  ${formatResumeCommand(slug, ctx.stats.model)}`));
      } catch (err) {
        ctx.out.error(`Named "${slug}" but save failed: ${errorMessage(err)}`);
      }
    } else {
      ctx.out.success(palette.success('Named') + palette.dim(`  ${slug}  (saves on first turn)`));
    }
    return 'continue';
  },
};
