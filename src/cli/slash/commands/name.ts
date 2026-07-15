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
 * the session has turns.
 */

import { palette } from '../../palette.js';
import { saveSession } from '../../session-store.js';
import { slugifySessionName } from '../../session-name.js';
import { formatResumeCommand } from '../../resume-command.js';
import type { SlashCommand } from '../types.js';

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

    // Persist now if there's something to save; otherwise the name rides
    // along on the first per-turn autosave. saveSession keys on sessionId,
    // not the name, so no duplicate sidecar is created.
    if (ctx.stats.totalTurns > 0) {
      try {
        saveSession(ctx.stats);
        ctx.out.success(palette.success('Named') + palette.dim(`  ${slug}`));
        ctx.out.line(palette.dim(`  Resume:  ${formatResumeCommand(slug, ctx.stats.model)}`));
      } catch (err) {
        ctx.out.error(`Named "${slug}" but save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      ctx.out.success(palette.success('Named') + palette.dim(`  ${slug}  (saves on first turn)`));
    }
    return 'continue';
  },
};
