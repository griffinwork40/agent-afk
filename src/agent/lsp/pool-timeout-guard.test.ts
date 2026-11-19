import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspClient, LspClientError } from './client.js';
import { LspServerPool, poolKey } from './pool.js';
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

describe('pooled request timeout incidents', () => {
  it('three timeouts on one warm client block the next acquisition without another spawn', async () => {
    const { pool, spec, root, guard, tick } = setup();
    const client = await pool.acquire(spec, root);
    vi.useFakeTimers();
    for (let i = 1; i <= 3; i++) {
      tick();
      await timeout(client);
      expect(guard.recentCrashes).toBe(i);
      expect(client.alive).toBe(true);
      if (i < 3) expect(await pool.acquire(spec, root)).toBe(client);
    }
    expect(guard.failed).toBe(true);
    await expect(pool.acquire(spec, root)).rejects.toMatchObject({
      kind: 'exited', message: 'LSP server disabled: crash-loop guard tripped',
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
    await timeout(client);
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
});
