/**
 * Tests for `afk daemon` command — Daemon Gap B (zero-config invocability).
 *
 * Covers:
 *   - `afk daemon` with no flags starts with sessionstart trigger + compiled
 *     default task (no error, no required options).
 *   - `afk daemon --task <x>` still wires through correctly.
 *   - `afk daemon --cron <expr>` auto-selects cron trigger.
 *   - `afk daemon --trigger cron` without --cron still produces an error.
 *   - Config-driven default: `daemon.task` from afk.config.json is used when
 *     no --task flag is provided.
 *   - `resolveTriggerMode` unit tests for all precedence branches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mocks — isolate filesystem, network, and long-running async calls
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    model: 'sonnet',
    maxTokens: 4096,
    temperature: 1.0,
    updatePolicy: 'notify',
  })),
}));

vi.mock('../../agent/daemon.js', () => ({
  startDaemon: vi.fn(async () => ({
    port: 7777,
    scheduler: {},
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    tickOnce: vi.fn(),
    fireOnStart: vi.fn(async () => []),
    stop: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn(async () => undefined),
  // `push` is imported by send-telegram.ts (via the tool-handlers chain pulled
  // in transitively through daemon.ts's executor imports). The mock must export
  // it or Vitest will throw "No push export defined on the mock".
  push: vi.fn(async () => undefined),
}));

vi.mock('../shared-helpers.js', () => ({
  parseThinking: vi.fn(() => undefined),
  parseEffort: vi.fn(() => undefined),
  getApiKey: vi.fn(() => undefined),
  getModel: vi.fn(() => 'sonnet'),
  getThinking: vi.fn(() => undefined),
  getEffort: vi.fn(() => undefined),
  // New exports used by buildDaemonSessionFactory (added in daemon.ts).
  parseProvider: vi.fn(() => undefined),
  getDefaultSubagentModel: vi.fn(() => 'sonnet'),
}));

vi.mock('../errors/index.js', () => ({
  handleCommandError: vi.fn((err: unknown): never => {
    throw err instanceof Error ? err : new Error(String(err));
  }),
}));

import { startDaemon } from '../../agent/daemon.js';
import { loadConfig } from '../config.js';
import { registerDaemonCommand } from './daemon.js';
import {
  resolveTriggerMode,
  resolveDefaultTask,
  resolveDefaultTaskId,
  COMPILED_DEFAULT_TASK,
  COMPILED_DEFAULT_TASK_ID,
} from '../daemon-options.js';

const mockStartDaemon = vi.mocked(startDaemon);
const mockLoadConfig = vi.mocked(loadConfig);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Commander program and parse daemon args. Returns after action resolves. */
async function runDaemon(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDaemonCommand(program);
  await program.parseAsync(['node', 'afk', 'daemon', ...args]);
}

// ---------------------------------------------------------------------------
// resolveTriggerMode — pure unit tests (no side effects)
// ---------------------------------------------------------------------------

describe('resolveTriggerMode', () => {
  it('returns sessionstart when neither --trigger nor --cron are provided (zero-config default)', () => {
    expect(resolveTriggerMode(undefined, undefined)).toBe('sessionstart');
  });

  it('returns sessionstart when --trigger is empty and --cron is absent', () => {
    expect(resolveTriggerMode('', undefined)).toBe('sessionstart');
  });

  it('returns cron when --cron is provided but --trigger is not', () => {
    expect(resolveTriggerMode(undefined, '0 */6 * * *')).toBe('cron');
  });

  it('returns cron when --trigger cron is explicit', () => {
    expect(resolveTriggerMode('cron', undefined)).toBe('cron');
  });

  it('returns sessionstart when --trigger sessionstart is explicit', () => {
    expect(resolveTriggerMode('sessionstart', undefined)).toBe('sessionstart');
  });

  it('returns both when --trigger both is explicit', () => {
    expect(resolveTriggerMode('both', '0 */6 * * *')).toBe('both');
  });

  it('throws on unknown --trigger value', () => {
    expect(() => resolveTriggerMode('weekly', undefined)).toThrow(/Invalid trigger/);
  });

  it('explicit --trigger cron wins over absence of --cron (throws is downstream concern)', () => {
    // resolveTriggerMode itself returns 'cron' — the CLI guard raises the error
    expect(resolveTriggerMode('cron', undefined)).toBe('cron');
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultTask / resolveDefaultTaskId — pure unit tests
// ---------------------------------------------------------------------------

describe('resolveDefaultTask', () => {
  it('falls back to COMPILED_DEFAULT_TASK when all inputs are absent', () => {
    expect(resolveDefaultTask(undefined, undefined, undefined)).toBe(COMPILED_DEFAULT_TASK);
  });

  it('uses flag value when provided (highest precedence)', () => {
    expect(resolveDefaultTask('/my-task', 'env-task', 'cfg-task')).toBe('/my-task');
  });

  it('uses env value when flag is absent', () => {
    expect(resolveDefaultTask(undefined, '/env-task', 'cfg-task')).toBe('/env-task');
  });

  it('uses config value when flag and env are absent', () => {
    expect(resolveDefaultTask(undefined, undefined, '/cfg-task')).toBe('/cfg-task');
  });

  it('treats whitespace-only flag as absent', () => {
    expect(resolveDefaultTask('   ', undefined, '/cfg-task')).toBe('/cfg-task');
  });
});

describe('resolveDefaultTaskId', () => {
  it('falls back to COMPILED_DEFAULT_TASK_ID when all inputs are absent', () => {
    expect(resolveDefaultTaskId(undefined, undefined, undefined)).toBe(COMPILED_DEFAULT_TASK_ID);
  });

  it('uses flag value when provided', () => {
    expect(resolveDefaultTaskId('my-id', undefined, undefined)).toBe('my-id');
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

describe('afk daemon (CLI integration)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalSigint: NodeJS.SignalsListener | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Prevent SIGINT handler registration from persisting across tests
    originalSigint = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('runs with no flags — uses sessionstart trigger and compiled default task', async () => {
    await runDaemon();

    expect(mockStartDaemon).toHaveBeenCalledOnce();
    const opts = mockStartDaemon.mock.calls[0]?.[0];
    expect(opts).toBeDefined();

    // The main task should use compiled defaults
    const tasks = opts?.tasks ?? [];
    const mainTask = tasks.find((t) => t.taskId !== 'worktree-prune');
    expect(mainTask).toBeDefined();
    expect(mainTask?.command).toBe(COMPILED_DEFAULT_TASK);
    expect(mainTask?.trigger).toBe('sessionstart');
    // No cron expression required for sessionstart
    expect(mainTask?.cronExpression).toBeUndefined();
  });

  it('passes --task through correctly', async () => {
    await runDaemon('--task', '/my-custom-task --flag');

    const opts = mockStartDaemon.mock.calls[0]?.[0];
    const mainTask = opts?.tasks?.find((t) => t.taskId !== 'worktree-prune');
    expect(mainTask?.command).toBe('/my-custom-task --flag');
  });

  it('uses sessionstart trigger even with a custom --task (no --cron)', async () => {
    await runDaemon('--task', '/some-task');

    const opts = mockStartDaemon.mock.calls[0]?.[0];
    const mainTask = opts?.tasks?.find((t) => t.taskId !== 'worktree-prune');
    expect(mainTask?.trigger).toBe('sessionstart');
  });

  it('auto-selects cron trigger when --cron is provided', async () => {
    await runDaemon('--cron', '0 */6 * * *');

    const opts = mockStartDaemon.mock.calls[0]?.[0];
    const mainTask = opts?.tasks?.find((t) => t.taskId !== 'worktree-prune');
    expect(mainTask?.trigger).toBe('cron');
    expect(mainTask?.cronExpression).toBe('0 */6 * * *');
  });

  it('errors when --trigger cron is explicit but --cron is absent', async () => {
    await expect(runDaemon('--trigger', 'cron')).rejects.toThrow(/--cron is required/);
  });

  it('reads daemon.task from afk.config.json when no --task is passed', async () => {
    mockLoadConfig.mockReturnValueOnce({
      model: 'sonnet',
      maxTokens: 4096,
      temperature: 1.0,
      updatePolicy: 'notify',
      daemon: { task: '/config-task --from-config' },
    });

    await runDaemon();

    const opts = mockStartDaemon.mock.calls[0]?.[0];
    const mainTask = opts?.tasks?.find((t) => t.taskId !== 'worktree-prune');
    expect(mainTask?.command).toBe('/config-task --from-config');
  });

  it('--task flag overrides daemon.task in config', async () => {
    mockLoadConfig.mockReturnValueOnce({
      model: 'sonnet',
      maxTokens: 4096,
      temperature: 1.0,
      updatePolicy: 'notify',
      daemon: { task: '/config-task' },
    });

    await runDaemon('--task', '/flag-task');

    const opts = mockStartDaemon.mock.calls[0]?.[0];
    const mainTask = opts?.tasks?.find((t) => t.taskId !== 'worktree-prune');
    expect(mainTask?.command).toBe('/flag-task');
  });
});
