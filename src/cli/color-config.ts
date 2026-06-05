/**
 * Color autodetection helper for the CLI.
 *
 * Configures chalk's color level based on:
 * 1. FORCE_COLOR (takes highest priority)
 * 2. NO_COLOR (per https://no-color.org, disables colors)
 * 3. CI environment variable (disables colors in CI)
 * 4. process.stdout.isTTY (disables colors when piped)
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
  }
}
