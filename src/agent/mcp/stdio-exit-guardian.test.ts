/**
 * Tests for the stdio MCP exit guardian (`stdio-exit-guardian.ts`).
 *
 * Every child spawned here ignores stdin EOF (a bare `setInterval`, or the
 * `test-server-stubborn.mjs` fixture), so it only exits when signalled. The
 * `afterEach` SIGKILLs every pid a test touched so a failing assertion can
 * never leak a process.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  registerStdioChild,
  terminateTrackedChildren,
  trackedStdioChildren,
  unregisterStdioChild,
} from './stdio-exit-guardian.js';
import { McpManager } from './manager.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUBBORN = resolve(here, '__fixtures__/test-server-stubborn.mjs');

const spawned = new Set<number>();
let manager: McpManager | undefined;
let tmp: string | undefined;

afterEach(async () => {
  if (manager) {
    await manager.disconnectAll();
    manager = undefined;
  }
  for (const pid of spawned) {
    unregisterStdioChild(pid);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  spawned.clear();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** Spawn a node child that ignores stdin EOF and never exits on its own. */
function spawnStubborn(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('spawn failed');
  spawned.add(pid);
  child.stdin.end(); // EOF is ignored — proves the guardian, not EOF, ends it.
  return pid;
}

describe('stdio exit guardian (unit)', () => {
  it('SIGTERMs registered children and leaves unregistered ones alone', async () => {
    const tracked = spawnStubborn();
    const untracked = spawnStubborn();
    const removed = spawnStubborn();
    registerStdioChild(tracked);
    registerStdioChild(removed);
    unregisterStdioChild(removed);

    terminateTrackedChildren();

    expect(await waitFor(() => !isAlive(tracked), 1000)).toBe(true);
    // Give a stray signal time to land before asserting it never did.
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(untracked)).toBe(true);
    expect(isAlive(removed)).toBe(true);
    expect(trackedStdioChildren()).toEqual([]);
  });

  it('swallows ESRCH for a pid that already exited', async () => {
    const pid = spawnStubborn();
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !isAlive(pid), 1000);
    registerStdioChild(pid);
    expect(() => terminateTrackedChildren()).not.toThrow();
    expect(trackedStdioChildren()).toEqual([]);
  });
});

describe('stdio exit guardian (McpManager integration)', () => {
  it(
    'tracks a stdio server pid from connect until the SDK close ladder reaps it',
    async () => {
      manager = await McpManager.fromConfig({
        stubborn: { type: 'stdio', command: process.execPath, args: [STUBBORN] },
      });
      expect(manager.getServerStates()[0]!.status).toBe('connected');
      const pids = trackedStdioChildren();
      expect(pids).toHaveLength(1);
      const pid = pids[0]!;
      spawned.add(pid);
      expect(isAlive(pid)).toBe(true);

      // disconnectAll resolves at its 1 s budget; the SDK keeps escalating in
      // the background (EOF ignored → SIGTERM at 2 s). Once the child's stdio
      // closes the pid must drop out of the guardian.
      await manager.disconnectAll();
      manager = undefined;
      expect(await waitFor(() => trackedStdioChildren().length === 0, 5000)).toBe(true);
      expect(await waitFor(() => !isAlive(pid), 1000)).toBe(true);
    },
    15_000,
  );

  it(
    'SIGTERMs a stubborn server when the host process exits right after disconnectAll',
    async () => {
      // The production shape: a short-lived host connects, calls
      // disconnectAll(), and exits immediately — before the SDK's unref'd
      // 2 s timer can SIGTERM the child. Without the guardian the server
      // is orphaned. Spawned via `node --import tsx/esm` (no shell, no shim).
      tmp = mkdtempSync(join(tmpdir(), 'afk-mcp-guardian-'));
      const hostScript = join(tmp, 'host.mts');
      writeFileSync(hostScript, [
        `import { McpManager } from ${JSON.stringify(pathToFileURL(resolve(here, 'manager.ts')).href)};`,
        `const m = await McpManager.fromConfig({ s: { type: 'stdio', command: process.execPath, args: [${JSON.stringify(STUBBORN)}] } });`,
        `const { trackedStdioChildren } = await import(${JSON.stringify(pathToFileURL(resolve(here, 'stdio-exit-guardian.ts')).href)});`,
        `process.stdout.write('PID=' + trackedStdioChildren()[0] + '\\n');`,
        'await m.disconnectAll();',
        'process.exit(0);',
      ].join('\n'));

      const res = spawnSync(process.execPath, ['--import', 'tsx/esm', hostScript], {
        encoding: 'utf8',
        timeout: 30_000,
        shell: false,
      });
      const match = /PID=(\d+)/.exec(res.stdout);
      expect(match, `host stdout: ${res.stdout}\nstderr: ${res.stderr}`).not.toBeNull();
      const pid = Number(match![1]);
      spawned.add(pid);
      expect(res.status).toBe(0);
      expect(await waitFor(() => !isAlive(pid), 1000)).toBe(true);
    },
    40_000,
  );
});
