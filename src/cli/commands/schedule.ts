/**
 * CLI subcommands for managing scheduled daemon tasks.
 *
 * Subcommands: add | list | remove | enable | disable | logs
 *
 * All commands call schedule-store.ts directly for persistence. Write ops
 * also attempt live-sync to the running daemon via the port file.
 *
 * @module cli/commands/schedule
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { handleCommandError } from '../errors/index.js';
import {
  loadSchedules,
  addSchedule,
  removeSchedule,
  toggleScheduleEnabled,
  toScheduledTask,
} from '../../agent/daemon/schedule-store.js';
import { validateScheduleCwd } from '../../agent/daemon/cwd-validator.js';
import { getTelemetryPath } from '../../paths.js';
import { trySyncToDaemon, SYNC_FAILED_NOTE } from '../../agent/daemon/http-client.js';

export function registerScheduleCommand(program: Command): void {
  const schedule = program.command('schedule').description('Manage scheduled daemon tasks');

  // schedule add
  schedule
    .command('add')
    .description('Add a new scheduled task')
    .requiredOption('--name <name>', 'Human-readable label')
    .requiredOption('--command <cmd>', 'Command to run')
    .requiredOption('--cron <expr>', 'Cron expression (5-field)')
    .option('--executor <type>', 'agent | shell (default: agent)', 'agent')
    .option('--trigger <mode>', 'cron | sessionstart | both', 'cron')
    .option('--notify <when>', 'failure | always | never', 'failure')
    .option('--cwd <path>', 'Per-task working directory (absolute path or ~/…)')
    .option('--disabled', 'Add in disabled state', false)
    .action(
      async (opts: {
        name: string;
        command: string;
        cron: string;
        executor: string;
        trigger: string;
        notify: string;
        cwd?: string;
        disabled: boolean;
      }) => {
        try {
          const executor = opts.executor as 'agent' | 'shell';
          if (executor !== 'agent' && executor !== 'shell') {
            console.error('Error: --executor must be "agent" or "shell"');
            process.exitCode = 1;
            return;
          }
          let resolvedCwd: string | undefined;
          if (opts.cwd !== undefined) {
            const cwdResult = validateScheduleCwd(opts.cwd);
            if (!cwdResult.ok) {
              console.error(`Error: ${cwdResult.error}`);
              process.exitCode = 1;
              return;
            }
            resolvedCwd = cwdResult.resolved;
          }
          const config = addSchedule({
            name: opts.name,
            command: opts.command,
            cron: opts.cron,
            ...(executor !== 'agent' ? { executor } : {}),
            trigger: opts.trigger as 'cron' | 'sessionstart' | 'both',
            notifyOn: opts.notify as 'failure' | 'always' | 'never',
            ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
            enabled: !opts.disabled,
          });
          // Mirror the create_schedule tool handler: enabled tasks are
          // POST-registered; a disabled task sends an idempotent DELETE so it
          // is never live-registered into (and fired by) a running daemon --
          // a 404 (not registered) counts as synced under end-state semantics.
          const syncAdd = config.enabled
            ? await trySyncToDaemon('POST', '/tasks', {
                taskId: config.id,
                command: config.command,
                cron: config.cron,
                ...(config.executor !== undefined ? { executor: config.executor } : {}),
                trigger: config.trigger,
                notifyOn: config.notifyOn,
                ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
              })
            : await trySyncToDaemon('DELETE', `/tasks/${config.id}`);
          if (!syncAdd.synced) console.error(`⚠️  ${SYNC_FAILED_NOTE}`);
          console.log(`✅ Added: ${config.id} — ${config.name}`);
        } catch (err) {
          handleCommandError(err);
        }
      },
    );

  // schedule list
  schedule
    .command('list')
    .description('List all scheduled tasks')
    .action(() => {
      try {
        const schedules = loadSchedules();
        if (schedules.length === 0) {
          console.log('No scheduled tasks.');
          return;
        }
        // ASCII table: ID | NAME | CRON | ENABLED
        const header = 'ID                   | NAME                           | CRON            | ENABLED';
        const sep = '-'.repeat(header.length);
        console.log(header);
        console.log(sep);
        for (const s of schedules) {
          console.log(
            [
              s.id.padEnd(20),
              s.name.padEnd(30),
              s.cron.padEnd(15),
              String(s.enabled),
            ].join(' | '),
          );
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  // schedule remove
  schedule
    .command('remove <id>')
    .description('Permanently remove a scheduled task')
    .action(async (id: string) => {
      try {
        const found = removeSchedule(id);
        if (!found) {
          console.error(`Task not found: ${id}`);
          process.exit(1);
        }
        const syncRemove = await trySyncToDaemon('DELETE', `/tasks/${id}`);
        if (!syncRemove.synced) console.error(`⚠️  ${SYNC_FAILED_NOTE}`);
        console.log(`✅ Removed: ${id}`);
      } catch (err) {
        handleCommandError(err);
      }
    });

  // schedule enable
  schedule.command('enable <id>').description('Enable a scheduled task').action(async (id: string) => {
    try {
      const updated = toggleScheduleEnabled(id, true);
      if (!updated) {
        console.error(`Task not found: ${id}`);
        process.exit(1);
      }
      const syncEnable = await trySyncToDaemon('POST', '/tasks', toScheduledTask(updated));
      if (!syncEnable.synced) console.error(`⚠️  ${SYNC_FAILED_NOTE}`);
      console.log(`✅ Enabled: ${id}`);
    } catch (err) {
      handleCommandError(err);
    }
  });

  // schedule disable
  schedule.command('disable <id>').description('Disable a scheduled task').action(async (id: string) => {
    try {
      const updated = toggleScheduleEnabled(id, false);
      if (!updated) {
        console.error(`Task not found: ${id}`);
        process.exit(1);
      }
      const syncDisable = await trySyncToDaemon('DELETE', `/tasks/${id}`);
      if (!syncDisable.synced) console.error(`⚠️  ${SYNC_FAILED_NOTE}`);
      console.log(`✅ Disabled: ${id}`);
    } catch (err) {
      handleCommandError(err);
    }
  });

  // schedule logs <id>
  schedule
    .command('logs <id>')
    .description('Show recent execution history for a task')
    .option('-n, --limit <n>', 'Number of records to show', '10')
    .action((id: string, opts: { limit: string }) => {
      try {
        const limit = Math.min(Math.max(1, parseInt(opts.limit, 10) || 10), 50);
        const telemetryPath = getTelemetryPath();
        if (!existsSync(telemetryPath)) {
          console.log(`No telemetry found for task: ${id}`);
          return;
        }
        // 1MB tail cap, reverse scan — same logic as getScheduleHistoryHandler
        const buf = readFileSync(telemetryPath);
        const tailBuf = buf.length > 1_048_576 ? buf.subarray(buf.length - 1_048_576) : buf;
        const content = tailBuf.toString('utf-8');
        const lines = content.split('\n');
        const matching: unknown[] = [];
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i];
          if (!line) continue;
          try {
            const record = JSON.parse(line) as { taskId?: string };
            if (record.taskId !== id) continue;
            matching.push(record);
            if (matching.length >= limit) break;
          } catch {
            continue;
          }
        }
        const results = matching.reverse(); // chronological order
        if (results.length === 0) {
          console.log(`No history found for task: ${id}`);
          return;
        }
        console.log(JSON.stringify(results, null, 2));
      } catch (err) {
        handleCommandError(err);
      }
    });
}
