/**
 * First-run welcome banner — shown exactly once, on the user's first
 * interactive REPL session, then never again.
 *
 * Detection: absence of the marker file at `~/.afk/state/.first-run-shown`.
 * After printing, the marker is written so subsequent launches skip it.
 *
 * Guards:
 *   - Non-TTY / non-interactive: skip (no banner in piped contexts).
 *   - Resume sessions: skip (user is not new; they have prior context).
 *   - Marker already present: skip.
 *   - Any I/O error writing the marker: silently swallow — the banner will
 *     re-appear next launch rather than crashing bootstrap.
 *
 * Style: palette.ts only (no raw chalk), 4–5 lines, calm, non-blocking.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getFirstRunMarkerPath } from '../../../paths.js';
import { palette } from '../../palette.js';

/**
 * True when this is the user's first interactive REPL session.
 * Pure function over the filesystem — no side effects.
 */
export function isFirstRun(): boolean {
  try {
    return !existsSync(getFirstRunMarkerPath());
  } catch {
    // Any error (e.g. AFK_STATE_DIR misconfigured) → treat as not-first-run
    // to avoid printing a banner on every run due to a persistent FS error.
    return false;
  }
}

/**
 * Mark the first run as seen so the banner does not repeat.
 * No-op when the marker already exists or when any I/O error occurs.
 */
export function markFirstRunSeen(): void {
  try {
    const markerPath = getFirstRunMarkerPath();
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, '', { flag: 'wx' }); // exclusive create — no-op if exists
  } catch {
    // Silently swallow — a repeat banner is preferable to a thrown error.
  }
}

/**
 * Options controlling whether the first-run banner should be shown.
 *
 * @param isTTY       - Whether stdout is a real terminal (skip in piped/CI contexts).
 * @param isResume    - Whether this is a resumed session (skip — not a new user).
 */
export interface FirstRunBannerOpts {
  isTTY: boolean;
  isResume: boolean;
}

/**
 * Render the first-run welcome banner to stdout and mark it as seen.
 * Returns `true` when the banner was printed, `false` when skipped.
 *
 * Call this AFTER the main welcome banner (in the pre-arm block of
 * `interactive.ts`) so the first-run hint appears below the mascot and
 * above the status line, close to the prompt where a new user will notice.
 */
export function printFirstRunBanner(opts: FirstRunBannerOpts): boolean {
  if (!opts.isTTY || opts.isResume) return false;
  if (!isFirstRun()) return false;

  // Write the marker BEFORE printing so a crash mid-print doesn't cause
  // a repeat on the next launch.
  markFirstRunSeen();

  console.log(
    [
      '',
      `  ${palette.bold('Welcome to AFK!')} Here are two good starting points:`,
      `  ${palette.info('/skills')} ${palette.dim('— browse 50+ amplifier skills (try /skills <query> to search by intent)')}`,
      `  ${palette.info('/help')}   ${palette.dim('— interactive command reference and tips')}`,
      '',
    ].join('\n'),
  );

  return true;
}
