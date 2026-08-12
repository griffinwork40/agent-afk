/**
 * Color autodetection helper for the CLI.
 *
 * Configures chalk's color level based on:
 * 1. FORCE_COLOR (takes highest priority)
 * 2. NO_COLOR (per https://no-color.org, disables colors)
 * 3. CI environment variable (disables colors in CI)
 * 4. process.stdout.isTTY (disables colors when piped)
 * 5. $TMUX + $COLORTERM — truecolor override for Node ≤ 24 (see below)
 *
 * History: before Node.js 25.0.0 (PR #58146), `tty.getColorDepth()` checked
 * $TMUX before $COLORTERM, returning 8 (256-color) even when
 * COLORTERM=truecolor was set. chalk's `supports-color` relies on
 * `getColorDepth()`, so it inherited the bug — capping at level 2 inside
 * tmux. Since agent-afk targets Node ≥ 22, users on Node 22–24 need an
 * explicit override. Step 5 detects tmux + COLORTERM=truecolor and forces
 * chalk.level = 3 (24-bit).
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

  // Invariant: tmux + COLORTERM=truecolor must produce chalk level 3 (24-bit).
  // On Node ≤ 24, getColorDepth() returns 8 inside tmux regardless of
  // COLORTERM, so chalk auto-detects level 2 (256-color). Override it.
  // TMUX and COLORTERM are OS-level terminal vars, intentionally outside
  // ENV_REGISTRY — read from process.env directly.
  const colorterm = process.env['COLORTERM'];
  if (
    process.env['TMUX'] &&
    (colorterm === 'truecolor' || colorterm === '24bit')
  ) {
    chalk.level = 3;
  }
}
