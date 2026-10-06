/**
 * Shared `schtasks` execution helpers for the Windows Task Scheduler backend.
 *
 * `schtasks()` and `errorDetail()` were duplicated identically between
 * `install.ts` and `manager.ts`. Extracted here so both modules import from
 * a single source of truth.
 *
 * @module service/windows/schtasks-exec
 */

import { execFileSync } from 'child_process';
import { SCHTASKS_TIMEOUT_MS } from './paths.js';
import { errorMessage } from '../../utils/errors.js';

/** Run a `schtasks` subcommand with standard options. */
export function schtasks(args: string[]): Buffer {
  return execFileSync('schtasks', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: SCHTASKS_TIMEOUT_MS,
  });
}

/** Extract the most actionable message from an execFileSync error. */
export function errorDetail(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  const text = stderr ? stderr.toString().trim() : '';
  return text || errorMessage(err);
}
