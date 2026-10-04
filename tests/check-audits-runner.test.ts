import { describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const exitMock = vi.hoisted(() => vi.fn((code?: string | number | null | undefined) => {
  throw new Error(`process.exit:${code}`);
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

describe('scripts/check-audits runner', () => {
  async function runWithStatuses(statuses: Array<number | Error>): Promise<{ exitCode: number; calls: unknown[][] }> {
    vi.resetModules();
    spawnSyncMock.mockReset();
    let index = 0;
    spawnSyncMock.mockImplementation(() => {
      const status = statuses[index++] ?? 0;
      if (status instanceof Error) return { stdout: '', stderr: '', error: status, status: null };
      return { stdout: '', stderr: '', status };
    });

    const originalArgv = process.argv;
    const originalExit = process.exit;
    const { fileURLToPath } = await import('node:url');
    const scriptPath = fileURLToPath(new URL('../scripts/check-audits.ts', import.meta.url));
    process.argv = [process.execPath, scriptPath];
    process.exit = exitMock as never;
    exitMock.mockClear();
    try {
      await import('../scripts/check-audits.js');
      return { exitCode: 0, calls: spawnSyncMock.mock.calls };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const match = /^process\.exit:(\d+)$/.exec(message);
      if (!match) throw err;
      return { exitCode: Number(match[1]), calls: spawnSyncMock.mock.calls };
    } finally {
      process.argv = originalArgv;
      process.exit = originalExit;
    }
  }

  it('does not execute gates when imported by tests', async () => {
    vi.resetModules();
    spawnSyncMock.mockReset();
    const originalArgv = process.argv;
    process.argv = [process.execPath, '/tmp/not-check-audits.ts'];
    try {
      const mod = await import('../scripts/check-audits.js');
      expect(mod.AUDIT_GATES.length).toBeGreaterThan(0);
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  it('runs pnpm gates with explicit repo cwd', async () => {
    const result = await runWithStatuses([]);
    expect(result.exitCode).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalled();
    for (const call of spawnSyncMock.mock.calls) {
      expect(call[0]).toBe('pnpm');
      expect(call[2]).toMatchObject({ cwd: expect.stringMatching(/agent-afk|pr2686-fix/), encoding: 'utf8' });
    }
  });

  it('exits 0 when every gate passes', async () => {
    const result = await runWithStatuses([]);
    expect(result.exitCode).toBe(0);
  });

  it('exits 1 when some gates fail', async () => {
    const result = await runWithStatuses([0, 1, 0]);
    expect(result.exitCode).toBe(1);
  });

  it('exits 2 when every gate fails or spawn errors', async () => {
    const allFail = await runWithStatuses(Array.from({ length: 20 }, () => 1));
    expect(allFail.exitCode).toBe(2);

    const spawnErrors = await runWithStatuses(Array.from({ length: 20 }, () => new Error('ENOENT')));
    expect(spawnErrors.exitCode).toBe(2);
  });
});
