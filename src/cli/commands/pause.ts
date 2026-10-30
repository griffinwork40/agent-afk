/**
 * `afk pause` — write a pause.lock file to freeze all running AFK sessions.
 *
 * Sessions check for the lock file at three points (SSE stream, tool
 * dispatch, turn boundary) and block until the lock is removed by
 * `afk resume`.
 *
 * @module cli/commands/pause
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { readPresenceFiles } from '../../agent/awareness/presence.js';
import { writePauseLock, getPauseLockPath } from '../../agent/session/pause-controller.js';
import { palette } from '../palette.js';

export function registerPauseCommand(program: Command): void {
  program
    .command('pause')
    .description('Freeze all running AFK sessions in place (write pause.lock)')
    .action(async () => {
      const lockPath = getPauseLockPath();

      if (existsSync(lockPath)) {
        console.log(palette.warning('⚠  AFK is already paused.'));
        console.log(palette.dim(`   Lock file: ${lockPath}`));
        process.exit(0);
      }

      // Count live sessions before writing the lock.
      let sessionCount = 0;
      try {
        const records = await readPresenceFiles();
        sessionCount = records.length;
      } catch {
        // Best-effort — don't abort the pause if presence dir is missing.
      }

      writePauseLock();

      if (sessionCount === 0) {
        console.log(palette.success('⏸  AFK paused.') + palette.dim(' (no active sessions detected)'));
      } else {
        const plural = sessionCount === 1 ? 'session' : 'sessions';
        console.log(
          palette.success('⏸  AFK paused.') +
            palette.dim(` ${sessionCount} active ${plural} will block at their next checkpoint.`),
        );
      }
      console.log(palette.dim(`   Run ${palette.fileRef('afk resume')} to unfreeze.`));
    });
}
