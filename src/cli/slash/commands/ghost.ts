/**
 * /ghost slash command — toggle ghost-text suggestions mid-session.
 *
 * Usage:
 *   /ghost       — show current status
 *   /ghost off   — pause ghost text for this session
 *   /ghost on    — resume ghost text
 *
 * Session-scoped: does not persist across restarts. Use
 * `interactive.suggestGhost` in afk.config.json (or AFK_SUGGEST_GHOST env)
 * for a permanent toggle.
 */

import type { SlashCommand } from '../types.js';
import { palette } from '../../palette.js';

export const ghostCmd: SlashCommand = {
  name: '/ghost',
  usage: '/ghost [on|off]',
  summary: 'Toggle ghost-text suggestions mid-session',
  hint:
    'Pause or resume inline ghost-text suggestions (the dim text after the cursor). ' +
    '`/ghost off` suppresses all ghost text for the rest of this session — nothing ' +
    'new appears and nothing new is recorded to history. `/ghost on` resumes. ' +
    'For a permanent toggle, set `interactive.suggestGhost: false` in afk.config.json.',
  flags: ['on', 'off'],
  async handler(ctx, args) {
    const compositor = ctx.getCompositor?.();
    if (!compositor) {
      ctx.out.warn('Ghost text is not available on this surface.');
      return 'continue';
    }

    // No ghost engine wired at all (AFK_SUGGEST_GHOST=0 at boot).
    if (!compositor.ghostEngine) {
      ctx.out.info(
        `Ghost text is ${palette.dim('disabled')} (set at boot via AFK_SUGGEST_GHOST or interactive.suggestGhost).`,
      );
      return 'continue';
    }

    const target = args.trim().toLowerCase();

    // No args — show status.
    if (!target) {
      const status = compositor.ghostPaused ? palette.dim('paused') : palette.brand('on');
      ctx.out.info(`Ghost text: ${status} (session-scoped)`);
      return 'continue';
    }

    if (target === 'off') {
      compositor.ghostPaused = true;
      compositor.activeGhost = null;
      compositor.repaint();
      ctx.out.success(
        `Ghost text paused for this session. Run ${palette.brand('/ghost on')} to resume.`,
      );
      return 'continue';
    }

    if (target === 'on') {
      compositor.ghostPaused = false;
      compositor.repaint();
      ctx.out.success('Ghost text resumed.');
      return 'continue';
    }

    ctx.out.warn(`Unknown argument: "${target}". Usage: /ghost [on|off]`);
    return 'continue';
  },
};
