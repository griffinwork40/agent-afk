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
import { join } from 'node:path';
import { handleCommandError } from '../errors/index.js';
import {
  loadSchedules,
  saveSchedules,
  addSchedule,
  removeSchedule,
  getSchedule,
} from '../../agent/daemon/schedule-store.js';
import { getDaemonStateDir, getTelemetryPath } from '../../paths.js';

// TODO: extract to src/agent/daemon/http-client.ts when shared with tool handlers
/**
 * Attempt to notify the running daemon of a task change.
 * Swallows all errors silently — file store is the source of truth.
 * STALE-FILE NOTE: port file may be stale after SIGKILL; fetch will fail
 * and be silently swallowed.
 */
async function trySyncToDaemon(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<void> {
  try {
    const portFile = join(getDaemonStateDir('default'), 'port');
    if (!existsSync(portFile)) return;
    const portStr = readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(portStr, 10);
    if (Number.isNaN(port)) return;
    await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Daemon not running or unreachable — silent failure
  }
}

export function registerScheduleCommand(program: Command): void {
  const schedule = program.command('schedule').description('Manage scheduled daemon tasks');

  // schedule add
  schedule
    .command('add')
    .description('Add a new scheduled task')
    .requiredOption('--name <name>', 'Human-readable label')
    .requiredOption('--command <cmd>', 'Command to run')
    .requiredOption('--cron <expr>', 'Cron expression (5-field)')
    .option('--trigger <mode>', 'cron | sessionstart | both', 'cron')
    .option('--notify <when>', 'failure | always | never', 'failure')
    .option('--disabled', 'Add in disabled state', false)
    .action(
      async (opts: {
        name: string;
        command: string;
        cron: string;
        trigger: string;
        notify: string;
        disabled: boolean;
      }) => {
        try {
          const config = addSchedule({
            name: opts.name,
            command: opts.command,
            cron: opts.cron,
            trigger: opts.trigger as 'cron' | 'sessionstart' | 'both',
            notifyOn: opts.notify as 'failure' | 'always' | 'never',
            enabled: !opts.disabled,
          });
          await trySyncToDaemon('POST', '/tasks', {
            taskId: config.id,
            command: config.command,
            cron: config.cron,
            trigger: config.trigger,
          });
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
        await trySyncToDaemon('DELETE', `/tasks/${id}`);
        console.log(`✅ Removed: ${id}`);
      } catch (err) {
        handleCommandError(err);
      }
    });

  // schedule enable
  schedule.command('enable <id>').description('Enable a scheduled task').action(async (id: string) => {
    try {
      const config = getSchedule(id);
      if (!config) {
        console.error(`Task not found: ${id}`);
        process.exit(1);
      }
      const schedules = loadSchedules();
      saveSchedules(
        schedules.map((s) =>
          s.id === id ? { ...s, enabled: true, updatedAt: new Date().toISOString() } : s,
        ),
      );
      await trySyncToDaemon('POST', '/tasks', {
        taskId: config.id,
        command: config.command,
        cron: config.cron,
        trigger: config.trigger,
      });
      console.log(`✅ Enabled: ${id}`);
    } catch (err) {
      handleCommandError(err);
    }
  });

  // schedule disable
  schedule.command('disable <id>').description('Disable a scheduled task').action(async (id: string) => {
    try {
      const config = getSchedule(id);
      if (!config) {
        console.error(`Task not found: ${id}`);
        process.exit(1);
      }
      const schedules = loadSchedules();
      saveSchedules(
        schedules.map((s) =>
          s.id === id ? { ...s, enabled: false, updatedAt: new Date().toISOString() } : s,
        ),
      );
      await trySyncToDaemon('DELETE', `/tasks/${id}`);
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
