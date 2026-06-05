/**
 * `afk queue` command — enqueue tasks for pull-trigger daemon mode.
 *
 * Usage:
 *   afk queue add <command>
 *   afk queue add "/forge-friction --auto" --notify-on failure
 *
 * Tasks are persisted as JSON files in `~/.afk/state/queue/`. A running
 * daemon with `--trigger pull` will dequeue and execute them one-by-one
 * on its poll interval (default 30s).
 *
 * TODO(#337-list): afk queue list/remove/clear — listPending() already supports this.
 *
 * @module cli/commands/queue
 */

import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enqueue } from '../../agent/daemon/queue-store.js';
import { getQueueDir } from '../../paths.js';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';

export function registerQueueCommand(program: Command): void {
  const queueCmd = program
    .command('queue')
    .description('Manage the pull-trigger task queue (used with `afk daemon --trigger pull`)');

  queueCmd
    .command('add <command>')
    .description('Enqueue a command for the pull-trigger daemon to execute')
    .option(
      '--notify-on <mode>',
      'When to send a notification: failure | always | never',
    )
    .action(
      (command: string, opts: { notifyOn?: string }) => {
        try {
          const queueDir = getQueueDir();
          mkdirSync(queueDir, { recursive: true });

          const notifyOn = opts.notifyOn as 'failure' | 'always' | 'never' | undefined;
          const task = enqueue(command, { notifyOn }, queueDir);

          const seq = String(task.sequence).padStart(4, '0');
          const filePath = join(queueDir, `${seq}-${task.id}.json`);

          console.log(palette.success(`✔ Queued task #${seq} (id: ${task.id})`));
          console.log(palette.dim(`  command: ${command}`));
          console.log(palette.dim(`  file: ${filePath}`));
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}
