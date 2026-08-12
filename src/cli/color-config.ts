/**
 * Color autodetection helper for the CLI.
 *
 * Configures chalk's color level based on:
 * 1. FORCE_COLOR (takes highest priority)
 * 2. NO_COLOR (per https://no-color.org, disables colors)
 * 3. CI environment variable (disables colors in CI)
 * 4. process.stdout.isTTY (disables colors when piped)
 *
 * Invariant: configureColor() may only LOWER chalk.level, never raise it.
 * chalk.hex() freezes color-space at builder creation time (ESM module
 * evaluation), which runs before configureColor(). A raise here would be a
 * no-op for palette tones — they are already locked at 256-color (level 2).
 *
 * tmux + truecolor (Node ≤ 24): before Node.js 25.0.0, tty.getColorDepth()
 * checked $TMUX before $COLORTERM, returning 8 (256-color) even when
 * COLORTERM=truecolor was set. To get 24-bit color inside tmux on Node 22–24,
 * set FORCE_COLOR=3 in your shell profile or ~/.afk/config/afk.env before
 * launching afk. FORCE_COLOR is read by chalk during initial auto-detection
 * (before module evaluation), so it correctly affects palette builders at
 * creation time. See docs/tmux.md for the full setup guide.
 *
 * Call this once at startup, after dotenv has loaded but before command registration.
 */

import chalk from 'chalk';
import { env } from '../config/env.js';

export function configureColor(): void {
  const force = env.FORCE_COLOR;
  if (force && force.length > 0) return;

  const noColor = env.NO_COLOR;
  if (noColor && noColor.length > 0) {
    chalk.level = 0;
    return;
  }

  const ci = env.CI;
  if (ci && ci.length > 0) {
    chalk.level = 0;
    return;
  }

  if (!process.stdout.isTTY) {
    chalk.level = 0;
    return;
  }
}
