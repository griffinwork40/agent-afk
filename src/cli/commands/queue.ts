/**
 * `afk queue` command — manage pull-trigger daemon task queue.
 *
 * Usage:
 *   afk queue add <command> [--notify-on failure|always|never]
 *   afk queue list
 *   afk queue remove <id>
 *   afk queue clear [--yes]
 *
 * Tasks are persisted as JSON files in `~/.afk/state/queue/`. A running
 * daemon with `--trigger pull` will dequeue and execute them one-by-one
 * on its poll interval (default 30s).
 *
 * @module cli/commands/queue
 */

import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enqueue, listPending, removePending, clearPending } from '../../agent/daemon/queue-store.js';
import { getQueueDir } from '../../paths.js';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';

export function registerQueueCommand(program: Command): void {
  const queueCmd = program
    .command('queue')
    .description('Manage the pull-trigger task queue (used with `afk daemon --trigger pull`)');

  // ---------------------------------------------------------------------------
  // add
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  queueCmd
    .command('list')
    .description('List all pending queued tasks in FIFO order')
    .action(() => {
      try {
        const queueDir = getQueueDir();
        const tasks = listPending(queueDir);

        if (tasks.length === 0) {
          console.log(palette.dim('No pending tasks in queue.'));
          return;
        }

        const header = `${'SEQ'.padEnd(4)}  ${'ID'.padEnd(26)}  ${'ENQUEUED'.padEnd(24)}  COMMAND`;
        const sep = '─'.repeat(header.length);
        console.log(palette.heading(header));
        console.log(palette.dim(sep));

        for (const task of tasks) {
          const seq = String(task.sequence).padStart(4, '0');
          const id = task.id.padEnd(26).slice(0, 26);
          const enqueued = task.enqueuedAt.padEnd(24).slice(0, 24);
          console.log(`${seq}  ${id}  ${enqueued}  ${task.command}`);
        }

        const plural = tasks.length === 1 ? 'task' : 'tasks';
        console.log(palette.dim(`\n${tasks.length} pending ${plural}.`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------

  queueCmd
    .command('remove <id>')
    .description('Remove a pending task by id')
    .action((id: string) => {
      try {
        const queueDir = getQueueDir();
        const removed = removePending(queueDir, id);

        if (!removed) {
          console.error(palette.error(`Task not found: ${id}`));
          console.error(palette.dim('  (already executed, already removed, or id is wrong)'));
          process.exit(1);
        }

        console.log(palette.success(`✔ Removed task ${id}`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  queueCmd
    .command('clear')
    .description('Remove all pending tasks from the queue')
    .option('-y, --yes', 'Skip the confirmation prompt (non-interactive / CI)')
    .action(async (opts: { yes?: boolean }) => {
      try {
        const queueDir = getQueueDir();
        const pending = listPending(queueDir);

        if (pending.length === 0) {
          console.log(palette.dim('Queue is already empty — nothing to clear.'));
          return;
        }

        // Confirmation gate. Interactive TTY → prompt; otherwise require --yes.
        if (opts.yes !== true) {
          if (!process.stdin.isTTY) {
            console.log(
              palette.warning(
                `Non-interactive shell: re-run with --yes to clear ${pending.length} pending task(s).`,
              ),
            );
            process.exit(0);
          }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = (
              await rl.question(
                palette.bold(`\nRemove all ${pending.length} pending task(s) from the queue? [y/N] `),
              )
            )
              .trim()
              .toLowerCase();
            if (answer !== 'y' && answer !== 'yes') {
              console.log(palette.dim('Aborted — queue unchanged.'));
              process.exit(0);
            }
          } finally {
            rl.close();
          }
        }

        const removed = clearPending(queueDir);
        const plural = removed === 1 ? 'task' : 'tasks';
        console.log(palette.success(`✔ Cleared ${removed} pending ${plural}.`));
      } catch (err) {
        handleCommandError(err);
      }
    });
}
