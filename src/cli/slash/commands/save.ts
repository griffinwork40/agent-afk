/**
 * /save [name] — checkpoint this session to disk now (for /resume).
 *
 * Sessions already autosave after every turn, so /save is rarely needed; it
 * exists for an explicit flush and as a backward-compatible way to name a
 * session. With a [name] arg it sets the session name — see /name, the
 * primary rename command. Always writes the single <sessionId>.json sidecar
 * (name is metadata, never the filename), so naming via /save never forks a
 * duplicate file the way the old `/save <name>` did.
 */

import { palette } from '../../palette.js';
import { saveSession } from '../../session-store.js';
import { slugifySessionName } from '../../session-name.js';
import { formatResumeCommand } from '../../resume-command.js';
import type { SlashCommand } from '../types.js';

export const saveCmd: SlashCommand = {
  name: '/save',
  usage: '/save [name]',
  hint: 'Checkpoint now (sessions already autosave each turn). Pass a name to label it — /name is the primary rename command.',
  summary: 'Save this session to disk (for /resume)',
  async handler(ctx, args) {
    if (ctx.stats.totalTurns === 0) {
      ctx.out.warn('Nothing to save — no turns in this session yet.');
      return 'continue';
    }
    const proposed = args.trim();
    if (proposed) {
      const slug = slugifySessionName(proposed);
      if (slug) {
        ctx.stats.name = slug;
      } else {
        ctx.out.warn('Ignoring invalid name — use letters, numbers, spaces, or hyphens.');
      }
    }
    try {
      // No overrideId: always key on sessionId so /save never forks a second
      // sidecar. The name (if any) is persisted as metadata in the payload.
      const path = saveSession(ctx.stats);
      ctx.out.success(palette.success('Saved') + palette.dim(`  ${path}`));
      const resumeTarget = ctx.stats.name ?? ctx.stats.sessionId;
      if (resumeTarget) {
        ctx.out.line(
          palette.dim(`  Resume:  ${formatResumeCommand(resumeTarget, ctx.stats.model)}`),
        );
      }
    } catch (err) {
      ctx.out.error(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 'continue';
  },
};
