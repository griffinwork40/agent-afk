/**
 * Tests for the `afk schedule` CLI subcommands.
 *
 * Suite 1 (live-sync parity): uses a real startDaemon so the CLI's port-file
 * discovery + live-sync round-trips against an actual daemon.
 *
 * Suite 2 (mock-based): covers all remaining branches (list, remove,
 * enable/disable not-found, logs, printScheduleList with/without cwd column,
 * executor validation, cwd validation, sync-fail warnings) with mocked IPC
 * and telemetry for speed and hermeticity.
 *
 * Both suites share one file. The http-client mock is set up with
 * importOriginal so it passes through to the real implementation by default
 * (suite 1 gets real daemon syncs); suite 2's beforeEach overrides it with
 * mockResolvedValue to isolate from any running daemon.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerScheduleCommand } from './schedule.js';
import { startDaemon, type DaemonHandle } from '../../agent/daemon.js';
import { loadSchedules, addSchedule } from '../../agent/daemon/schedule-store.js';

// debug.js: expose all real exports, just silence debugLog.
vi.mock('../../utils/debug.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/debug.js')>();
  return { ...actual, debugLog: vi.fn() };
});

// http-client: wrap with a spy that passes through to the real implementation
// by default. Suite 2 overrides with mockResolvedValue in beforeEach.
vi.mock('../../agent/daemon/http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/daemon/http-client.js')>();
  return {
    ...actual,
    trySyncToDaemon: vi.fn(actual.trySyncToDaemon),
  };
});

// telemetry-reader: always mocked (never needed for real I/O in tests).
vi.mock('../../agent/daemon/telemetry-reader.js', () => ({
  readTelemetryHistory: vi.fn(async () => []),
}));

// paths.js: spread real exports, override only getTelemetryPath.
vi.mock('../../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../paths.js')>();
  return {
    ...actual,
    getTelemetryPath: vi.fn(() => '/tmp/afk-test-telemetry.jsonl'),
  };
});

import { trySyncToDaemon } from '../../agent/daemon/http-client.js';
import { readTelemetryHistory } from '../../agent/daemon/telemetry-reader.js';

const FAR_FUTURE_CRON = '59 23 31 12 *';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerScheduleCommand(program);
  return program;
}

async function daemonTasks(port: number): Promise<string[]> {
  const list = (await (
    await fetch(`http://localhost:${port}/tasks`)
  ).json()) as Array<{ taskId: string }>;
  return list.map((t) => t.taskId);
}

// ---------------------------------------------------------------------------
// Suite 1: live-sync parity (real daemon, http-client passes through)
// ---------------------------------------------------------------------------

describe('afk schedule CLI — live-sync parity', () => {
  let tmpDir: string;
  let handle: DaemonHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-sched-live-'));
    vi.stubEnv('AFK_HOME', tmpDir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Restore pass-through before each live test so the real daemon receives syncs.
    const { trySyncToDaemon: real } = await vi.importActual<
      typeof import('../../agent/daemon/http-client.js')
    >('../../agent/daemon/http-client.js');
    vi.mocked(trySyncToDaemon).mockImplementation(real);
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
    const entry = loadSchedules().find((s) => s.name === 'Cli Disabled');
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
    expect(await daemonTasks(handle.port)).not.toContain(entry!.id);
  });

  it('add (enabled) DOES live-register the task — positive control', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Cli Enabled', '--command', '/x', '--cron', FAR_FUTURE_CRON,
    ]);
    const entry = loadSchedules().find((s) => s.name === 'Cli Enabled');
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

// ---------------------------------------------------------------------------
// Suite 2: mock-based — covers remaining branches hermetically
// ---------------------------------------------------------------------------

describe('afk schedule CLI — mock-based branch coverage', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-sched-mock-'));
    vi.stubEnv('AFK_HOME', tmpDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Override to a stub — no real daemon needed for these tests.
    vi.mocked(trySyncToDaemon).mockResolvedValue({ synced: true, detail: 'synced' });
    vi.mocked(readTelemetryHistory).mockClear();
    vi.mocked(readTelemetryHistory).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // schedule list
  // -------------------------------------------------------------------------

  it('list prints "No scheduled tasks." when store is empty', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'list']);
    expect(logSpy).toHaveBeenCalledWith('No scheduled tasks.');
  });

  it('list prints table without CWD column when no task has a cwd', async () => {
    addSchedule({ name: 'Task A', command: '/cmd', cron: FAR_FUTURE_CRON });
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'list']);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((l) => l.includes('ID'))).toBe(true);
    expect(calls.some((l) => l.includes('CWD'))).toBe(false);
    expect(calls.some((l) => l.includes('Task A'))).toBe(true);
  });

  it('list prints CWD column when at least one task has a cwd', async () => {
    addSchedule({ name: 'Task B', command: '/cmd', cron: FAR_FUTURE_CRON, cwd: tmpDir });
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'list']);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((l) => l.includes('CWD'))).toBe(true);
    expect(calls.some((l) => l.includes(tmpDir))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // schedule add — option validation
  // -------------------------------------------------------------------------

  it('add rejects invalid --executor value', async () => {
    const origExit = process.exitCode;
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'X', '--command', '/x', '--cron', FAR_FUTURE_CRON,
      '--executor', 'invalid',
    ]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--executor must be'));
    expect(process.exitCode).toBe(1);
    process.exitCode = origExit;
  });

  it('add rejects a --cwd that does not exist', async () => {
    const origExit = process.exitCode;
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'X', '--command', '/x', '--cron', FAR_FUTURE_CRON,
      '--cwd', '/nonexistent-path-afk-test-xyz',
    ]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    expect(process.exitCode).toBe(1);
    process.exitCode = origExit;
  });

  it('add with --executor shell stores correct executor', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Shell Task', '--command', 'echo hi', '--cron', FAR_FUTURE_CRON,
      '--executor', 'shell',
    ]);
    const entry = loadSchedules().find((s) => s.name === 'Shell Task');
    expect(entry).toBeDefined();
    expect(entry?.executor).toBe('shell');
  });

  it('add with valid --cwd stores the resolved path', async () => {
    const cwdDir = join(tmpDir, 'subdir');
    mkdirSync(cwdDir);
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Cwd Task', '--command', '/x', '--cron', FAR_FUTURE_CRON,
      '--cwd', cwdDir,
    ]);
    const entry = loadSchedules().find((s) => s.name === 'Cwd Task');
    expect(entry).toBeDefined();
    expect(entry?.cwd).toBe(cwdDir);
  });

  it('add logs sync-failed warning when daemon sync fails', async () => {
    vi.mocked(trySyncToDaemon).mockResolvedValue({ synced: false, detail: 'daemon-not-detected' });
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Sync Fail', '--command', '/x', '--cron', FAR_FUTURE_CRON,
    ]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Change saved'));
  });

  it('add with --notify always persists notifyOn', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Notify Task', '--command', '/x', '--cron', FAR_FUTURE_CRON,
      '--notify', 'always',
    ]);
    expect(loadSchedules().find((s) => s.name === 'Notify Task')?.notifyOn).toBe('always');
  });

  it('add with --trigger sessionstart persists trigger', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'add',
      '--name', 'Trigger Task', '--command', '/x', '--cron', FAR_FUTURE_CRON,
      '--trigger', 'sessionstart',
    ]);
    expect(loadSchedules().find((s) => s.name === 'Trigger Task')?.trigger).toBe('sessionstart');
  });

  // -------------------------------------------------------------------------
  // schedule remove
  // -------------------------------------------------------------------------

  it('remove prints success and syncs DELETE when task exists', async () => {
    const cfg = addSchedule({ name: 'To Remove', command: '/x', cron: FAR_FUTURE_CRON });
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'remove', cfg.id]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Removed'));
    expect(vi.mocked(trySyncToDaemon)).toHaveBeenCalledWith('DELETE', `/tasks/${cfg.id}`);
    expect(loadSchedules().find((s) => s.id === cfg.id)).toBeUndefined();
  });

  it('remove calls process.exit(1) when task not found', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'remove', 'nonexistent-id']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Task not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('remove logs sync-failed warning when daemon sync fails', async () => {
    vi.mocked(trySyncToDaemon).mockResolvedValue({ synced: false, detail: 'daemon-not-detected' });
    const cfg = addSchedule({ name: 'Remove Sync Fail', command: '/x', cron: FAR_FUTURE_CRON });
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'remove', cfg.id]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Change saved'));
  });

  // -------------------------------------------------------------------------
  // schedule enable
  // -------------------------------------------------------------------------

  it('enable calls process.exit(1) when task not found', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'enable', 'nonexistent-id']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Task not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('enable logs sync-failed warning when daemon sync fails', async () => {
    vi.mocked(trySyncToDaemon).mockResolvedValue({ synced: false, detail: 'daemon-not-detected' });
    const cfg = addSchedule({
      name: 'Enable Sync Fail', command: '/x', cron: FAR_FUTURE_CRON, enabled: false,
    });
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'enable', cfg.id]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Change saved'));
  });

  // -------------------------------------------------------------------------
  // schedule disable
  // -------------------------------------------------------------------------

  it('disable prints success and syncs DELETE when task exists', async () => {
    const cfg = addSchedule({ name: 'To Disable', command: '/x', cron: FAR_FUTURE_CRON });
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'disable', cfg.id]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Disabled'));
    expect(vi.mocked(trySyncToDaemon)).toHaveBeenCalledWith('DELETE', `/tasks/${cfg.id}`);
  });

  it('disable calls process.exit(1) when task not found', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'disable', 'nonexistent-id']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Task not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('disable logs sync-failed warning when daemon sync fails', async () => {
    vi.mocked(trySyncToDaemon).mockResolvedValue({ synced: false, detail: 'daemon-not-detected' });
    const cfg = addSchedule({ name: 'Disable Sync Fail', command: '/x', cron: FAR_FUTURE_CRON });
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'disable', cfg.id]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Change saved'));
  });

  // -------------------------------------------------------------------------
  // schedule logs
  // -------------------------------------------------------------------------

  it('logs prints "No history found" when readTelemetryHistory returns empty', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'logs', 'some-task-id']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No history found'));
  });

  it('logs prints JSON when readTelemetryHistory returns records', async () => {
    const fakeRecord = { taskId: 'some-task-id', status: 'success', startedAt: 1000 };
    vi.mocked(readTelemetryHistory).mockResolvedValue([fakeRecord as never]);
    await buildProgram().parseAsync(['node', 'afk', 'schedule', 'logs', 'some-task-id']);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([fakeRecord], null, 2));
  });

  it('logs clamps limit to 50 for large values', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'logs', 'some-task-id', '--limit', '999',
    ]);
    const calls = vi.mocked(readTelemetryHistory).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][1].limit).toBe(50);
  });

  it('logs defaults limit to 10 for non-numeric input', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'schedule', 'logs', 'some-task-id', '--limit', 'abc',
    ]);
    const calls = vi.mocked(readTelemetryHistory).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][1].limit).toBe(10);
  });
});
