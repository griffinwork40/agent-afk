/**
 * /theme slash command — switch the TUI color palette mid-session.
 *
 * Exposes the boot-time `--theme <dark|light|auto>` flag / `AFK_THEME` env /
 * `theme` config key as a runtime toggle so the operator can flip the palette
 * without restarting the REPL. `applyTheme()` rewrites the live palette in
 * place and drops the syntax-highlight cache; a `getCompositor().repaint()`
 * restyles the active frame immediately. Already-committed scrollback keeps
 * its baked ANSI — only the active frame and new output adopt the new tones.
 *
 * Session-scoped: the swap lasts for this REPL session. To persist across
 * sessions, set the config key: `afk config set theme light`.
 *
 * Usage:
 *   /theme          — show the active theme
 *   /theme dark     — the default palette
 *   /theme light    — palette retuned for light-background terminals
 *   /theme auto     — detect from the terminal (COLORFGBG; falls back to dark)
 */

import type { SlashCommand } from '../types.js';
import { palette } from '../../palette.js';
import {
  applyTheme,
  getActiveTheme,
  parseThemeMode,
  resolveTheme,
  type ThemeMode,
} from '../../theme.js';

const VALID_MODES: readonly ThemeMode[] = ['dark', 'light', 'auto'];

export const themeCmd: SlashCommand = {
  name: '/theme',
  usage: '/theme [dark|light|auto]',
  summary: 'Switch the TUI color palette (dark/light) mid-session',
  hint:
    'Switch the color palette: `dark` (default), `light` (retuned for light-background ' +
    'terminals), or `auto` (detect from the terminal, falling back to dark). ' +
    'Applies to the active frame and new output immediately; already-printed scrollback ' +
    'keeps its original colors. Session-scoped — persist with `afk config set theme <mode>`. ' +
    'Run without args to see the active theme.',
  flags: ['dark', 'light', 'auto'],
  async handler(ctx, args) {
    const raw = args.trim();

    // No args → report the active (resolved) theme.
    if (!raw) {
      ctx.out.info(`Theme: ${palette.brand(getActiveTheme())}`);
      return 'continue';
    }

    const mode = parseThemeMode(raw);
    if (mode === undefined) {
      ctx.out.warn(`Invalid theme: "${raw}". Valid: ${VALID_MODES.join(', ')}`);
      return 'continue';
    }

    const applied = resolveTheme(mode);
    applyTheme(applied);

    // Restyle the active frame right away. getCompositor is absent/null on
    // non-TTY surfaces or before the compositor arms — tolerate both.
    ctx.getCompositor?.()?.repaint();

    const detail = mode === 'auto' ? ` (auto → ${applied})` : '';
    ctx.out.success(
      `Theme set to ${palette.brand(applied)}${detail}. ` +
      `Session-scoped — persist with \`afk config set theme ${mode}\`.`,
    );
    return 'continue';
  },
};
