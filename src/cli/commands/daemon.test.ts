/**
 * Tests for `afk daemon` command — Daemon Gap B (zero-config invocability).
 *
 * Covers:
 *   - `afk daemon` with no flags starts with sessionstart trigger and does NOT
 *     fabricate a default task (no error, no required options).
 *   - `afk daemon --task <x>` still wires through correctly.
 *   - `afk daemon --task <x> --cron <expr>` auto-selects cron trigger.
 *   - `afk daemon --cron <expr>` without a task produces an error.
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
    host: '127.0.0.1',
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
  // Opt-in top-level tool-round ceiling reader; undefined = unlimited (default).
  getMaxToolUseIterations: vi.fn(() => undefined),
}));

vi.mock('../errors/index.js', () => ({
  handleCommandError: vi.fn((err: unknown): never => {
    throw err instanceof Error ? err : new Error(String(err));
  }),
}));

import { startDaemon } from '../../agent/daemon.js';
import { pushIfConfigured } from '../../telegram/push.js';
import { loadConfig } from '../config.js';
import { formatTaskCompletion, registerDaemonCommand } from './daemon.js';
import {
  resolveTriggerMode,
  resolveDefaultTask,
  resolveDefaultTaskId,
  COMPILED_DEFAULT_TASK,
  COMPILED_DEFAULT_TASK_ID,
} from '../daemon-options.js';

const mockStartDaemon = vi.mocked(startDaemon);
const mockLoadConfig = vi.mocked(loadConfig);
const mockPushIfConfigured = vi.mocked(pushIfConfigured);

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

  it('runs with no flags — sessionstart trigger, no fabricated default task', async () => {
    await runDaemon();

    expect(mockStartDaemon).toHaveBeenCalledOnce();
    const opts = mockStartDaemon.mock.calls[0]?.[0];
    expect(opts).toBeDefined();

    // With no --task / env / config task, the daemon no longer invents a
    // default task (previously '/forge-friction --auto'). The 'default' task id
    // is unique to that fabricated task, so its absence is the precise signal —
    // robust even if persisted schedules exist on the test machine.
    const tasks = opts?.tasks ?? [];
    expect(tasks.find((t) => t.taskId === COMPILED_DEFAULT_TASK_ID)).toBeUndefined();
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

  it('auto-selects cron trigger when --cron is provided (with a task)', async () => {
    await runDaemon('--task', '/my-task --auto', '--cron', '0 */6 * * *');

    const opts = mockStartDaemon.mock.calls[0]?.[0];
    const mainTask = opts?.tasks?.find((t) => t.taskId === COMPILED_DEFAULT_TASK_ID);
    expect(mainTask?.command).toBe('/my-task --auto');
    expect(mainTask?.trigger).toBe('cron');
    expect(mainTask?.cronExpression).toBe('0 */6 * * *');
  });

  it('errors when --cron is provided but no task is configured', async () => {
    await expect(runDaemon('--cron', '0 */6 * * *')).rejects.toThrow(
      /task is required for the cron and both triggers/,
    );
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

  it('formats full completion response text when callback details include it', () => {
    const fullResponse = `${'a'.repeat(700)}\nfinal line`;
    const formatted = formatTaskCompletion(
      {
        taskId: 'nightly',
        command: 'run',
        trigger: 'cron',
        triggeredAt: new Date(0).toISOString(),
        durationMs: 1200,
        status: 'success',
        responseExcerpt: 'short excerpt',
      },
      { responseText: fullResponse },
    );

    expect(formatted).toContain('daemon task: nightly (success)');
    expect(formatted).toContain('final line');
    expect(formatted).not.toContain('short excerpt');
  });

  it('forwards scheduler completion details to Telegram notification formatting', async () => {
    await runDaemon();

    const opts = mockStartDaemon.mock.calls[0]?.[0];
    opts?.onTaskComplete?.(
      {
        taskId: 'nightly',
        command: 'run',
        trigger: 'cron',
        triggeredAt: new Date(0).toISOString(),
        durationMs: 1200,
        status: 'success',
        responseExcerpt: 'short excerpt',
      },
      { responseText: 'full daemon output' },
    );

    expect(mockPushIfConfigured).toHaveBeenCalledWith(
      expect.stringContaining('full daemon output'),
      { markdown: true },
    );
  });
});

describe('formatTaskCompletion — "Done" verification downgrade', () => {
  const successRecord = () => ({
    taskId: 'nightly',
    command: 'run',
    trigger: 'cron' as const,
    triggeredAt: new Date(0).toISOString(),
    durationMs: 1200,
    status: 'success' as const,
    responseExcerpt: 'shipped it',
  });

  it('downgrades the header + appends the caveat when doneUnverified AND verifyDone on', () => {
    const formatted = formatTaskCompletion(
      successRecord(),
      { responseText: 'shipped it', doneUnverified: true },
      true,
    );
    expect(formatted).toContain('⚠️ Done (unverified)');
    expect(formatted).toContain(
      'no file write/edit or successful command recorded this turn',
    );
    // Success ✅ header must be gone (replaced by the downgrade header).
    expect(formatted).not.toContain('✅ daemon task');
    // The response body is still present.
    expect(formatted).toContain('shipped it');
  });

  it('output is byte-identical to the no-flag call when verifyDone is off', () => {
    const record = successRecord();
    const details = { responseText: 'shipped it', doneUnverified: true };
    // Explicit off, explicit off-via-omitted-arg, and the historical 2-arg call
    // must all produce exactly the same string as today.
    const off = formatTaskCompletion(record, details, false);
    const baseline = formatTaskCompletion(record, { responseText: 'shipped it' });
    expect(off).toBe(baseline);
    expect(formatTaskCompletion(record, details)).toBe(baseline);
    expect(off).not.toContain('unverified');
    expect(off).toContain('✅ daemon task: nightly (success)');
  });

  it('does NOT downgrade when verifyDone on but doneUnverified is absent/false', () => {
    const record = successRecord();
    const on = formatTaskCompletion(record, { responseText: 'shipped it' }, true);
    // No doneUnverified ⇒ identical to the plain success push.
    expect(on).toBe(formatTaskCompletion(record, { responseText: 'shipped it' }));
    expect(on).not.toContain('unverified');
    const explicitFalse = formatTaskCompletion(
      record,
      { responseText: 'shipped it', doneUnverified: false },
      true,
    );
    expect(explicitFalse).not.toContain('unverified');
  });
});
