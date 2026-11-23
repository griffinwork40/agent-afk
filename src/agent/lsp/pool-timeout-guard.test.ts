import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspClient, LspClientError } from './client.js';
import { LspServerPool, poolKey, TIMEOUT_EXIT_FALLOUT_MS } from './pool.js';
import { CrashLoopGuard } from './crash-loop-guard.js';
import { TYPESCRIPT_SERVER_DEFINITION } from './typescript-default.js';
import { writeFakeLspServer, type FakeServerConfig } from './__test-utils__/fake-lsp-server.js';
import type { ServerSpec } from './server-spec.js';

const pools: LspServerPool[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(pools.splice(0).map((pool) => pool.disposeAll()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setup(config: FakeServerConfig = { hangRequests: true }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-timeout-guard-'));
  roots.push(root);
  const script = path.join(root, 'server.cjs');
  writeFakeLspServer(script, config);
  const spec: ServerSpec = {
    definition: TYPESCRIPT_SERVER_DEFINITION, command: process.execPath, args: [script], source: 'override',
  };
  const guards = new Map<string, CrashLoopGuard>();
  let now = 0;
  const guardFor = (key: string) => {
    let guard = guards.get(key);
    if (!guard) guards.set(key, guard = new CrashLoopGuard({ now: () => now }));
    return guard;
  };
  const pool = new LspServerPool({ guardFor });
  pools.push(pool);
  return { root, spec, pool, guardFor, guard: guardFor(poolKey(spec, root)), tick: () => { now += 1_000; } };
}

async function timeout(client: LspClient) {
  const result = client.request('textDocument/definition', {}, { timeoutMs: 100 }).catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ kind: 'timeout' });
}

/** Real-timer timeout: a tripping timeout evicts, and dispose needs real jsonrpc I/O. */
async function realTimeout(client: LspClient) {
  vi.useRealTimers();
  await expect(client.request('textDocument/definition', {}, { timeoutMs: 50 }))
    .rejects.toMatchObject({ kind: 'timeout' });
}

describe('pooled request timeout incidents', () => {
  it('three timeouts on one warm client block the next acquisition without another spawn', async () => {
    const { pool, spec, root, guard, tick } = setup();
    const client = await pool.acquire(spec, root);
    vi.useFakeTimers();
    for (let i = 1; i <= 3; i++) {
      tick();
      if (i < 3) await timeout(client); else await realTimeout(client);
      expect(guard.recentCrashes).toBe(i);
      if (i < 3) {
        expect(client.alive).toBe(true);
        expect(await pool.acquire(spec, root)).toBe(client);
      }
    }
    expect(guard.failed).toBe(true);
    expect(pool.size).toBe(0);
    await client.dispose();
    await expect(pool.acquire(spec, root)).rejects.toMatchObject({
      kind: 'disabled', message: 'LSP server disabled: crash-loop guard tripped',
    });
    expect(pool.spawned).toBe(1);
  });

  it('does not count exit after a timeout again; a new client crash still counts', async () => {
    const { pool, spec, root, guard } = setup();
    const client = await pool.acquire(spec, root);
    vi.useFakeTimers();
    await timeout(client);
    client.killSync();
    expect(pool.size).toBe(0);
    expect(guard.recentCrashes).toBe(1);
    vi.useRealTimers();
    await client.dispose();
    const next = await pool.acquire(spec, root);
    next.killSync();
    expect(guard.recentCrashes).toBe(2);
    expect(guard.failed).toBe(false);
    await next.dispose();
  });

  it('counts a later exit after the client recovered from a timeout', async () => {
    const { pool, spec, root, guard } = setup();
    const client = await pool.acquire(spec, root);
    // Leave setImmediate real so the recovery request's JSON-RPC I/O completes.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await timeout(client);
    await expect(client.request('shutdown', null, { timeoutMs: 5_000 })).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(TIMEOUT_EXIT_FALLOUT_MS + 1);
    client.killSync();
    expect(pool.size).toBe(0);
    expect(guard.recentCrashes).toBe(2);
    vi.useRealTimers();
    await client.dispose();
  });

  it('evicts and disposes the hung client when a timeout trips the guard, without another incident', async () => {
    const { pool, spec, root, guard } = setup();
    const record = vi.spyOn(guard, 'recordCrash');
    const client = await pool.acquire(spec, root);
    const disposeSpy = vi.spyOn(client, 'dispose');
    await realTimeout(client);
    await realTimeout(client);
    expect(pool.size).toBe(1);
    await realTimeout(client);
    expect(guard.failed).toBe(true);
    expect(pool.size).toBe(0);
    // The pool must have triggered dispose itself when evicting the client.
    expect(disposeSpy).toHaveBeenCalled();
    // Wait for the client to fully shut down before the test ends.
    await client.dispose();
    expect(client.alive).toBe(false);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('never counts a start killed after every acquirer timed out', async () => {
    const { root, spec, guard } = setup({ silent: true });
    const record = vi.spyOn(guard, 'recordCrash');
    const starts: Array<Promise<unknown>> = [];
    const realStart = LspClient.start.bind(LspClient);
    vi.spyOn(LspClient, 'start').mockImplementation((...args) => {
      const started = realStart(...args);
      starts.push(started.catch(() => undefined));
      return started;
    });
    const pool = new LspServerPool({ guardFor: () => guard, abandonedStartGraceMs: 20 });
    pools.push(pool);
    vi.useFakeTimers();
    for (let i = 1; i <= 3; i++) {
      const result = pool.acquire(spec, root, { timeoutMs: 50 }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject({ kind: 'timeout' });
      expect(guard.recentCrashes).toBe(0);
      expect(pool.size).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(pool.size).toBe(0);
      expect(guard.recentCrashes).toBe(0);
    }
    expect(guard.failed).toBe(false);
    // A 4th acquire should still be able to spawn (guard not tripped).
    const fourth = pool.acquire(spec, root, { timeoutMs: 50 }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(50);
    expect(await fourth).toMatchObject({ kind: 'timeout' });
    expect(pool.spawned).toBe(4);
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    await Promise.all(starts);
    expect(record).not.toHaveBeenCalled();
  });

  it('three starts abandoned by abort (never timed out) leave the guard clean and allow a fresh start', async () => {
    const { root, spec, guard } = setup({ silent: true });
    const starts: Array<Promise<unknown>> = [];
    const realStart = LspClient.start.bind(LspClient);
    vi.spyOn(LspClient, 'start').mockImplementation((...args) => {
      const started = realStart(...args);
      starts.push(started.catch(() => undefined));
      return started;
    });
    const pool = new LspServerPool({ guardFor: () => guard, abandonedStartGraceMs: 20 });
    pools.push(pool);
    vi.useFakeTimers();
    for (let i = 1; i <= 3; i++) {
      const controller = new AbortController();
      const result = pool.acquire(spec, root, { signal: controller.signal }).catch((err: unknown) => err);
      controller.abort();
      expect(await result).toMatchObject({ kind: 'aborted' });
      expect(guard.recentCrashes).toBe(0);
      expect(pool.size).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(pool.size).toBe(0);
      expect(guard.recentCrashes).toBe(0);
    }
    expect(guard.failed).toBe(false);
    // Pool should accept a fresh start after three abort-only abandoned starts.
    const fourth = pool.acquire(spec, root, { timeoutMs: 50 }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(50);
    expect(await fourth).toMatchObject({ kind: 'timeout' });
    expect(pool.spawned).toBe(4);
    // Advance past the grace window so the 4th start's abandon timer fires and
    // the aborted start process resolves, allowing Promise.all(starts) to settle.
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    await Promise.all(starts);
  });

  it('one start with one timeout acquirer and one aborted acquirer records zero incidents after grace', async () => {
    const { root, spec, guard } = setup({ silent: true });
    const starts: Array<Promise<unknown>> = [];
    const realStart = LspClient.start.bind(LspClient);
    vi.spyOn(LspClient, 'start').mockImplementation((...args) => {
      const started = realStart(...args);
      starts.push(started.catch(() => undefined));
      return started;
    });
    const pool = new LspServerPool({ guardFor: () => guard, abandonedStartGraceMs: 20 });
    pools.push(pool);
    vi.useFakeTimers();
    // Acquirer A: times out after 50 ms.
    const resultA = pool.acquire(spec, root, { timeoutMs: 50 }).catch((err: unknown) => err);
    // Acquirer B: aborted immediately.
    const controller = new AbortController();
    const resultB = pool.acquire(spec, root, { signal: controller.signal }).catch((err: unknown) => err);
    controller.abort();
    expect(await resultB).toMatchObject({ kind: 'aborted' });
    // Still one waiter (A); no incident yet, start still alive.
    expect(guard.recentCrashes).toBe(0);
    expect(pool.size).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(await resultA).toMatchObject({ kind: 'timeout' });
    // Grace window: both acquirers gone but start still live.
    expect(pool.size).toBe(1);
    expect(guard.recentCrashes).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    // Grace timer fired: start was caller-abandoned, so zero incidents.
    expect(pool.size).toBe(0);
    expect(guard.recentCrashes).toBe(0);
    expect(pool.spawned).toBe(1);
    vi.useRealTimers();
    await Promise.all(starts);
  });

  it('does not count an abandoned start that a new acquirer picks up within grace', async () => {
    const { root, spec, guard } = setup({ silent: true });
    const pool = new LspServerPool({ guardFor: () => guard, abandonedStartGraceMs: 20 });
    pools.push(pool);
    vi.useFakeTimers();
    const first = pool.acquire(spec, root, { timeoutMs: 50 }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toMatchObject({ kind: 'timeout' });
    const second = pool.acquire(spec, root, { timeoutMs: 50 }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10);
    expect(pool.size).toBe(1);
    expect(guard.recentCrashes).toBe(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(await second).toMatchObject({ kind: 'timeout' });
    expect(pool.spawned).toBe(1);
    expect(guard.recentCrashes).toBe(0);
  });

  it('counts concurrent timed-out requests once each, not again on exit', async () => {
    const { pool, spec, root, guard } = setup();
    const client = await pool.acquire(spec, root);
    const observer = vi.fn();
    client.onRequestTimeout(observer);
    vi.useFakeTimers();
    const requests = [1, 2].map(() => client.request('textDocument/references', {}, { timeoutMs: 100 })
      .catch((err: unknown) => err));
    await vi.advanceTimersByTimeAsync(100);
    for (const result of await Promise.all(requests)) expect(result).toMatchObject({ kind: 'timeout' });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(guard.recentCrashes).toBe(2);
    client.killSync();
    expect(guard.recentCrashes).toBe(2);
    vi.useRealTimers();
    await client.dispose();
  });

  it('counts process death once for concurrent requests and cancels their deadlines', async () => {
    const { pool, spec, root, guard } = setup();
    const client = await pool.acquire(spec, root);
    const observer = vi.fn();
    client.onRequestTimeout(observer);
    vi.useFakeTimers();
    const requests = [1, 2, 3].map(() => client.request('textDocument/references', {}, { timeoutMs: 100 })
      .catch((err: unknown) => err));
    client.killSync();
    for (const result of await Promise.all(requests)) expect(result).toMatchObject({ kind: 'exited' });
    await vi.advanceTimersByTimeAsync(100);
    expect(observer).not.toHaveBeenCalled();
    expect(guard.recentCrashes).toBe(1);
    vi.useRealTimers();
    await client.dispose();
  });

  it('does not count aborts or the abandoned deadline, including concurrent abort and timeout', async () => {
    const { pool, spec, root, guard } = setup();
    const client = await pool.acquire(spec, root);
    vi.useFakeTimers();
    const controller = new AbortController();
    const aborted = client.request('textDocument/references', {}, { timeoutMs: 100, signal: controller.signal })
      .catch((err: unknown) => err);
    controller.abort();
    expect(await aborted).toMatchObject({ kind: 'aborted' });
    await vi.advanceTimersByTimeAsync(100);
    expect(guard.recentCrashes).toBe(0);
    expect(await pool.acquire(spec, root)).toBe(client);
    const second = new AbortController();
    const pending = client.request('textDocument/references', {}, { timeoutMs: 100, signal: second.signal })
      .catch((err: unknown) => err);
    second.abort();
    await timeout(client);
    expect(await pending).toMatchObject({ kind: 'aborted' });
    expect(guard.recentCrashes).toBe(1);
  });

  it('keeps incidents isolated by root, language, command and args', async () => {
    const { pool, spec, root, guard, guardFor } = setup();
    const client = await pool.acquire(spec, root);
    vi.useFakeTimers();
    await timeout(client);
    await timeout(client);
    // Third timeout trips the guard: evicts the entry. Use realTimeout so the
    // evicted client is fully disposed before afterEach removes the temp root.
    await realTimeout(client);
    await client.dispose();
    expect(guard.failed).toBe(true);
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-other-root-'));
    roots.push(otherRoot);
    const variants: Array<[ServerSpec, string]> = [
      [spec, otherRoot],
      [{ ...spec, definition: { ...spec.definition, language: 'other' } }, root],
      [{ ...spec, command: `${spec.command}-other` }, root],
      [{ ...spec, args: [...spec.args, 'other'] }, root],
    ];
    for (const [otherSpec, other] of variants) {
      expect(guardFor(poolKey(otherSpec, other)).recentCrashes).toBe(0);
    }
    vi.useRealTimers();
    const otherClient = await pool.acquire(spec, otherRoot);
    expect(otherClient.alive).toBe(true);
  });

  it('counts an initialize timeout once for concurrent acquirers, despite disposal/exit', async () => {
    const { root, spec, guard } = setup({ silent: true });
    const pool = new LspServerPool({
      guardFor: () => guard,
      startClient: (server, cwd) => LspClient.start(server, cwd, { timeoutMs: 50 }),
    });
    pools.push(pool);
    const results = await Promise.all([1, 2, 3].map(() => pool.acquire(spec, root).catch((err: unknown) => err)));
    for (const result of results) expect(result).toMatchObject({ kind: 'timeout' });
    expect(pool.spawned).toBe(1);
    expect(pool.size).toBe(0);
    expect(guard.recentCrashes).toBe(1);
  });

  it.each(['aborted', 'spawn'] as const)('excludes %s start failures with multiple acquirers', async (kind) => {
    const { root, spec, guard } = setup();
    const pool = new LspServerPool({
      guardFor: () => guard,
      startClient: async () => { throw new LspClientError(kind, kind); },
    });
    pools.push(pool);
    const results = await Promise.all([1, 2, 3].map(() => pool.acquire(spec, root).catch((err: unknown) => err)));
    for (const result of results) expect(result).toMatchObject({ kind });
    expect(guard.recentCrashes).toBe(0);
  });

  it('does not turn a response error or successful response into a timeout incident', async () => {
    const { pool, spec, root, guard } = setup({ requestError: true });
    const client = await pool.acquire(spec, root);
    await expect(client.request('textDocument/definition', {}, { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ kind: 'response' });
    await expect(client.request('shutdown', null, { timeoutMs: 5_000 })).resolves.toBeNull();
    expect(guard.recentCrashes).toBe(0);
  });

  it('a server whose start outlives three short-budget acquires is still usable by a later longer-budget acquire', async () => {
    // Regression: a healthy server with a ~3s cold start must not be disabled
    // by three diagnostics calls (short timeoutMs) before it has warmed up.
    //
    // Setup: shared root/key, guard with injectable clock.
    const { root, spec, guard } = setup({ silent: true });
    // A second fixture server that responds normally (for the 4th start).
    const { spec: realSpec } = setup();  // uses hangRequests:true default, but responds to initialize

    // startClient: starts 1-3 hang (never-settling promise that rejects when
    // aborted externally); start 4 uses the real responding server script.
    let startCount = 0;
    const hangAborts: AbortController[] = [];
    const pool = new LspServerPool({
      guardFor: () => guard,
      abandonedStartGraceMs: 20,
      startClient: (_serverSpec, cwd) => {
        startCount++;
        if (startCount <= 3) {
          const ac = new AbortController();
          hangAborts.push(ac);
          return new Promise<LspClient>((_, reject) => {
            if (ac.signal.aborted) { reject(new LspClientError('aborted', 'Aborted')); return; }
            ac.signal.addEventListener('abort', () =>
              reject(new LspClientError('aborted', 'Aborted')), { once: true });
          });
        }
        // 4th: use the real responding server (realSpec has the responding script).
        return LspClient.start(realSpec, cwd);
      },
    });
    pools.push(pool);

    vi.useFakeTimers();
    // Three acquires, each with a short budget, each abandoned by deadline.
    for (let i = 1; i <= 3; i++) {
      const result = pool.acquire(spec, root, { timeoutMs: 50 }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject({ kind: 'timeout' });
      expect(guard.recentCrashes).toBe(0);
      expect(pool.size).toBe(1); // still in grace
      await vi.advanceTimersByTimeAsync(20); // fire grace timer -> abort + evict
      // Settle the hanging start promise so it doesn't block disposeAll.
      hangAborts[i - 1]!.abort();
      expect(pool.size).toBe(0);
      expect(guard.recentCrashes).toBe(0);
    }
    expect(guard.failed).toBe(false);

    // Switch to real timers for the 4th acquire against the real responding server.
    vi.useRealTimers();
    const client = await pool.acquire(spec, root, { timeoutMs: 5_000 });
    expect(client.alive).toBe(true);
    expect(guard.failed).toBe(false);
    expect(guard.recentCrashes).toBe(0);
    expect(pool.spawned).toBe(4);

    // Clean up: dispose live client before afterEach removes the root dir.
    await client.dispose();
  });
});
