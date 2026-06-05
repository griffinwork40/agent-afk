/**
 * `.env` file primitives shared across surfaces.
 *
 * Originally co-located with `src/cli/auth-wizard.ts` (which calls
 * `upsertEnvVar` when persisting an Anthropic OAuth token), but the
 * Telegram setup wizard (`src/telegram/setup-wizard.ts`) and the
 * `afk telegram` setup commands need the same primitive — without those
 * surfaces reaching upward into `src/cli/auth-wizard.js`. This file is
 * the canonical home; `src/cli/auth-wizard.ts` re-exports for backward
 * compat with existing CLI import sites.
 *
 * @module utils/envFile
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Write or update a single env var in a `.env`-style file.
 *
 * - Creates parent directories if they do not exist.
 * - Writes the file with restrictive permissions (`0o600`) so secrets are
 *   not world-readable.
 * - If the key already exists, the existing line is replaced in-place.
 * - Any additional keys listed in `keysToRemove` are stripped from the
 *   file in the same pass (used when swapping between mutually-exclusive
 *   auth keys, e.g. `ANTHROPIC_API_KEY` vs `CLAUDE_CODE_OAUTH_TOKEN`).
 *
 * Values are written verbatim — no quoting or escaping. The caller is
 * responsible for ensuring the value does not contain newlines.
 */
export function upsertEnvVar(
  filePath: string,
  key: string,
  value: string,
  keysToRemove: string[] = [],
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let contents = '';
  if (existsSync(filePath)) {
    contents = readFileSync(filePath, 'utf-8');
  }
  // Remove any stale conflicting keys
  for (const removeKey of keysToRemove) {
    const removeRegex = new RegExp(`^${removeKey}=.*$\n?`, 'm');
    contents = contents.replace(removeRegex, '');
  }
  const line = `${key}=${value}`;
  const keyRegex = new RegExp(`^${key}=.*$`, 'm');
  if (keyRegex.test(contents)) {
    contents = contents.replace(keyRegex, line);
  } else {
    if (contents && !contents.endsWith('\n')) contents += '\n';
    contents += line + '\n';
  }
  writeFileSync(filePath, contents, { mode: 0o600 });
}
