/**
 * `afk resume` — remove the pause.lock file to unfreeze all blocked sessions.
 *
 * Sessions that were blocked at a PauseController.check() call will unblock
 * within 250 ms (poll interval) or sooner (fs.watch fast path).
 *
 * @module cli/commands/resume-all
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { removePauseLock, getPauseLockPath } from '../../agent/session/pause-controller.js';
import { palette } from '../palette.js';

export function registerResumeAllCommand(program: Command): void {
  program
    .command('resume')
    .description('Unfreeze all paused AFK sessions (remove pause.lock)')
    .action(() => {
      const lockPath = getPauseLockPath();

      if (!existsSync(lockPath)) {
        console.log(palette.warning('⚠  AFK is not currently paused.'));
        console.log(palette.dim(`   Lock file not found: ${lockPath}`));
        process.exit(0);
      }

      removePauseLock();

      console.log(palette.success('▶  AFK resumed.') + palette.dim(' All paused sessions will continue.'));
    });
}
