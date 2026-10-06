/**
 * Tests for telemetry-write-guard.ts (issue #2955).
 *
 * Covers:
 *  - `probeTelemetryWritable`: absent file → null; writable file → null;
 *    read-only file → error string; absent file with read-only parent → error
 *    string (portable: uses injected probe, no chmodSync on directory).
 *  - `TelemetryAlertLatch`: first detection sends a Telegram push; subsequent
 *    detections in the same process do not; real notify() exercises
 *    console.warn and pushIfConfigured.
 *  - Integration: CronScheduler.fireOnStart skips agent sessionstart tasks and
 *    sends exactly one alert when the telemetry file is not writable.
 *
 * @module agent/daemon/telemetry-write-guard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeTelemetryWritable, TelemetryAlertLatch } from './telemetry-write-guard.js';

// ─── Determine whether this platform enforces file-mode permissions ────────────
// On some CI environments (root user, Windows) chmod may not restrict access.
function platformEnforcesFileMode(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'afk-perm-check-'));
  const probeFile = join(probeDir, 'probe');
  try {
    writeFileSync(probeFile, 'x', 'utf-8');
    chmodSync(probeFile, 0o444);
    try {
      accessSync(probeFile, constants.W_OK);
      return false; // write still permitted — permissions not enforced
    } catch {
      return true; // write correctly denied
    }
  } finally {
    try { chmodSync(probeFile, 0o644); } catch { /* ignore */ }
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const PERMS_ENFORCED = platformEnforcesFileMode();

// ─── probeTelemetryWritable ────────────────────────────────────────────────────

describe('probeTelemetryWritable', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-tel-guard-'));
    filePath = join(dir, 'telemetry.jsonl');
  });

  afterEach(() => {
    try { chmodSync(filePath, 0o644); } catch { /* ignore — file may not exist */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist and the parent directory is writable', () => {
    // dir is freshly created and writable; filePath does not exist yet.
    expect(probeTelemetryWritable(filePath)).toBeNull();
  });

  it('returns an error string when the file is absent but the parent dir is read-only (injected probe)', () => {
    // Inject a fake accessSync that denies writes to the parent directory.
    // This is portable across Windows and root CI where chmodSync on a dir has
    // no effect — the probe function is the test boundary, not the OS.
    const eaccessErr = Object.assign(new Error('EACCES: permission denied, access \'/fake/dir\''), {
      code: 'EACCES',
    });
    const probe = {
      existsSync: () => false,   // file does not exist
      accessSync: (_p: string, _mode: number) => { throw eaccessErr; },
    };
    const result = probeTelemetryWritable(filePath, probe);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('returns null when the file exists and is writable', () => {
    writeFileSync(filePath, '', 'utf-8');
    expect(probeTelemetryWritable(filePath)).toBeNull();
  });

  it.skipIf(!PERMS_ENFORCED)('returns an error string when the file is read-only', () => {
    writeFileSync(filePath, '{"taskId":"t"}\n', 'utf-8');
    chmodSync(filePath, 0o444);
    const result = probeTelemetryWritable(filePath);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });
});

// ─── TelemetryAlertLatch ──────────────────────────────────────────────────────

describe('TelemetryAlertLatch', () => {
  it('fires the underlying push exactly once for repeated notify calls', async () => {
    const pushMock = vi.fn().mockResolvedValue(null);
    const fakePath = join(tmpdir(), 'afk-latch-test.jsonl');

    // Subclass to intercept the push without mocking the ES module at this scope.
    class TestLatch extends TelemetryAlertLatch {
      override async notify(path: string, errno: string): Promise<void> {
        if ((this as unknown as { alerted: boolean }).alerted) return;
        (this as unknown as { alerted: boolean }).alerted = true;
        await pushMock(path, errno);
      }
    }

    const latch = new TestLatch();
    await latch.notify(fakePath, 'EACCES: permission denied');
    await latch.notify(fakePath, 'EACCES: permission denied');
    await latch.notify(fakePath, 'EACCES: permission denied');

    expect(pushMock).toHaveBeenCalledOnce();
  });

  it('fires again after _reset()', async () => {
    const pushMock = vi.fn().mockResolvedValue(null);
    const fakePath = join(tmpdir(), 'afk-latch-reset.jsonl');

    class TestLatch extends TelemetryAlertLatch {
      override async notify(path: string, errno: string): Promise<void> {
        if ((this as unknown as { alerted: boolean }).alerted) return;
        (this as unknown as { alerted: boolean }).alerted = true;
        await pushMock(path, errno);
      }
    }

    const latch = new TestLatch();
    await latch.notify(fakePath, 'EACCES');
    latch._reset();
    await latch.notify(fakePath, 'EACCES');

    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it('real notify() calls console.warn and pushIfConfigured on first invocation only', async () => {
    // Exercise the real notify() path (no subclass override) so pushIfConfigured
    // and console.warn are confirmed to be called.
    // pushIfConfigured is already mocked via the hoisted vi.mock above.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fakePath = join(tmpdir(), 'afk-latch-real.jsonl');
    const latch = new TelemetryAlertLatch();

    await latch.notify(fakePath, 'ENOENT: no such file');
    await latch.notify(fakePath, 'ENOENT: no such file'); // latch is now armed

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Telemetry file is not writable');

    warnSpy.mockRestore();
  });
});

// ─── CronScheduler integration ────────────────────────────────────────────────
// Verifies fireOnStart skips agent tasks and sends one alert on a non-writable
// telemetry file (issue #2955 acceptance criteria).

vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(null),
}));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => {} },
  }),
}));

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

// Import AFTER vi.mock declarations so mocks are registered first.
import { CronScheduler } from './scheduler.js';
import { pushIfConfigured } from '../../telegram/push.js';

describe.skipIf(!PERMS_ENFORCED)(
  'CronScheduler.fireOnStart — non-writable telemetry file (issue #2955)',
  () => {
    let dir: string;
    let telemetryPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'afk-sched-guard-'));
      telemetryPath = join(dir, 'forge-telemetry.jsonl');
      // Pre-create the file so the W_OK probe detects it as unwritable.
      writeFileSync(telemetryPath, '', 'utf-8');
      chmodSync(telemetryPath, 0o444);
      vi.mocked(pushIfConfigured).mockClear();
    });

    afterEach(() => {
      try { chmodSync(telemetryPath, 0o644); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    });

    it('skips agent sessionstart tasks and does not spawn a session', async () => {
      const sessionFactory = vi.fn().mockReturnValue({
        sendMessage: vi.fn().mockResolvedValue({ content: 'done' }),
        close: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new CronScheduler({
        telemetryPath,
        sessionFactory,
        budgetGate: async () => ({ skip: false }),
      });

      scheduler.register({
        taskId: 'agent-start-task',
        command: 'run diagnostics',
        executor: 'agent',
        trigger: 'sessionstart',
      });

      const records = await scheduler.fireOnStart();
      await scheduler.stop();

      expect(sessionFactory).not.toHaveBeenCalled();
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('skipped');
      expect(records[0].skipReason).toBe('telemetry-unwritable');
    });

    it('sends exactly one Telegram alert even when multiple agent tasks are registered', async () => {
      const sessionFactory = vi.fn().mockReturnValue({
        sendMessage: vi.fn().mockResolvedValue({ content: 'done' }),
        close: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new CronScheduler({
        telemetryPath,
        sessionFactory,
        budgetGate: async () => ({ skip: false }),
      });

      scheduler.register({
        taskId: 'agent-start-a',
        command: 'task a',
        executor: 'agent',
        trigger: 'sessionstart',
      });
      scheduler.register({
        taskId: 'agent-start-b',
        command: 'task b',
        executor: 'agent',
        trigger: 'both',
        cronExpression: '* * * * *',
      });

      const records = await scheduler.fireOnStart();
      await scheduler.stop();

      expect(sessionFactory).not.toHaveBeenCalled();
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.status === 'skipped')).toBe(true);
      expect(records.every((r) => r.skipReason === 'telemetry-unwritable')).toBe(true);

      // Wait for the fire-and-forget Telegram push to settle.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(vi.mocked(pushIfConfigured)).toHaveBeenCalledOnce();
    });

    it('does not skip shell sessionstart tasks with the write-guard (they run normally)', async () => {
      const scheduler = new CronScheduler({
        telemetryPath,
        budgetGate: async () => ({ skip: false }),
      });

      scheduler.register({
        taskId: 'shell-start',
        command: 'node --version', // no-op: exits 0 on all platforms
        executor: 'shell',
        trigger: 'sessionstart',
      });

      const records = await scheduler.fireOnStart();
      await scheduler.stop();

      // Shell task must NOT be blocked by the write-guard.
      const guardSkips = records.filter((r) => r.skipReason === 'telemetry-unwritable');
      expect(guardSkips).toHaveLength(0);

      // The record should reflect a successful run or an error (not a guard skip).
      expect(records).toHaveLength(1);
      expect(records[0].status).not.toBe('skipped');
    });
  },
);
