/**
 * Tests for the `afk schedule` CLI subcommands — focused on live-sync parity
 * with the create_schedule tool handler.
 *
 * Uses vi.stubEnv('AFK_HOME', tmpDir) to isolate schedules.json + the daemon
 * port file, and a real startDaemon({ port: 0 }) so the CLI's port-file
 * discovery + live-sync round-trips against an actual daemon (mirrors the
 * handler test in src/agent/tools/handlers/schedules.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerScheduleCommand } from './schedule.js';
import { startDaemon, type DaemonHandle } from '../../agent/daemon.js';
import { loadSchedules } from '../../agent/daemon/schedule-store.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

const FAR_FUTURE_CRON = '59 23 31 12 *';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerScheduleCommand(program);
  return program;
}

async function daemonTasks(port: number): Promise<string[]> {
  const list = (await (await fetch(`http://localhost:${port}/tasks`)).json()) as Array<{
    taskId: string;
  }>;
  return list.map((t) => t.taskId);
}

describe('afk schedule CLI — live-sync parity', () => {
  let tmpDir: string;
  let handle: DaemonHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-cli-'));
    vi.stubEnv('AFK_HOME', tmpDir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Real daemon writes the port file under the stubbed AFK_HOME, so the CLI
    // add/enable/disable actions discover and sync to it.
    handle = await startDaemon({ port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('add --disabled does NOT live-register the task into a running daemon', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Cli Disabled', '--command', '/x', '--cron', FAR_FUTURE_CRON, '--disabled',
    ]);

    const stored = loadSchedules();
    const entry = stored.find((s) => s.name === 'Cli Disabled');
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
    // The disabled task is persisted but must NOT appear in the daemon's
    // in-memory registry — otherwise it fires on schedule until restart.
    expect(await daemonTasks(handle.port)).not.toContain(entry!.id);
  });

  it('add (enabled) DOES live-register the task — positive control', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Cli Enabled', '--command', '/x', '--cron', FAR_FUTURE_CRON,
    ]);

    const stored = loadSchedules();
    const entry = stored.find((s) => s.name === 'Cli Enabled');
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(true);
    expect(await daemonTasks(handle.port)).toContain(entry!.id);
  });

  it('disable unregisters a live task; enable re-registers it', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Cli Toggle', '--command', '/x', '--cron', FAR_FUTURE_CRON,
    ]);
    const id = loadSchedules().find((s) => s.name === 'Cli Toggle')!.id;
    expect(await daemonTasks(handle.port)).toContain(id);

    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'disable', id]);
    expect(await daemonTasks(handle.port)).not.toContain(id);

    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'enable', id]);
    expect(await daemonTasks(handle.port)).toContain(id);
  });
});
