/**
 * `afk resume` — remove the pause.lock file to unfreeze all blocked sessions.
 *
 * Sessions that were blocked at a PauseController.check() call will unblock
 * within 250 ms (poll interval) or sooner (fs.watch fast path).
 *
 * @module cli/commands/resume-all
 */

import { readFileSync } from 'fs';
import { Command } from 'commander';
import { removePauseLock, getPauseLockPath } from '../../agent/session/pause-controller.js';
import { formatDuration } from '../format-utils.js';
import { palette } from '../palette.js';

export function registerResumeAllCommand(program: Command): void {
  program
    .command('resume')
    .description('Unfreeze all paused AFK sessions (remove pause.lock)')
    .action(() => {
      // Read the lock file timestamp before removing so we can show pause duration.
      let pausedFor = '';
      try {
        const raw = readFileSync(getPauseLockPath(), 'utf8');
        const data: { timestamp?: string } = JSON.parse(raw);
        if (data.timestamp) {
          const elapsed = Date.now() - new Date(data.timestamp).getTime();
          if (elapsed > 0) pausedFor = ` (paused for ${formatDuration(elapsed)})`;
        }
      } catch { /* lock missing or unparseable — skip duration */ }

      // removePauseLock already swallows ENOENT — idempotent, no TOCTOU.
      removePauseLock();
      console.log(palette.success('▶  AFK resumed.') + pausedFor + palette.dim(' All paused sessions will continue.')); // console-ok
    });
}
