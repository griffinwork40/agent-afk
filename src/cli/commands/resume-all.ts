/**
 * `afk resume` — remove the pause.lock file to unfreeze all blocked sessions.
 *
 * Sessions that were blocked at a PauseController.check() call will unblock
 * within 250 ms (poll interval) or sooner (fs.watch fast path).
 *
 * @module cli/commands/resume-all
 */

import { Command } from 'commander';
import { removePauseLock } from '../../agent/session/pause-controller.js';
import { palette } from '../palette.js';

export function registerResumeAllCommand(program: Command): void {
  program
    .command('resume')
    .description('Unfreeze all paused AFK sessions (remove pause.lock)')
    .action(() => {
      // removePauseLock already swallows ENOENT — idempotent, no TOCTOU.
      removePauseLock();
      console.log(palette.success('▶  AFK resumed.') + palette.dim(' All paused sessions will continue.'));
    });
}
