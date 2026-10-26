/**
 * LspServerPool + LspClient behaviour against the fake LSP server
 * (spawned via process.execPath): reuse, dedupe, crash respawn, idle
 * shutdown, abort/cancel, workspace/configuration, didChange versioning.
 */

import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  writeFakeLspServer,
  spawnCount,
  messagesWithMethod,
  readFakeLog,
  fakeServerCmd,
  pidAlive,
  type FakeServerConfig,
} from './__test-utils__/fake-lsp-server.js';
import { LspServerPool, getIdleShutdownMs, DEFAULT_LSP_IDLE_SHUTDOWN_MS } from './pool.js';
import { LspClientError } from './client.js';
import { withPooledFile, awaitSyncDiagnostics } from './query.js';
import { DiagnosticsStore } from './diagnostics-store.js';
import { pathToFileURL } from 'node:url';
import { TYPESCRIPT_SERVER_DEFINITION } from './typescript-default.js';
import type { ServerSpec } from './server-spec.js';

const tempDir = path.join(os.tmpdir(), `afk-lsp-pool-test-${process.pid}-${randomBytes(4).toString('hex')}`);
mkdirSync(tempDir, { recursive: true });
let counter = 0;
const pools: LspServerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
  rmSync(tempDir, { recursive: true, force: true });
});

/** Fresh fake server + log + spec; settings feed workspace/configuration. */
function setup(config: FakeServerConfig = {}, settings?: Record<string, unknown>) {
  const id = ++counter;
  const logFile = path.join(tempDir, `log-${id}.jsonl`);
  const script = path.join(tempDir, `server-${id}.js`);
  writeFakeLspServer(script, { logFile, ...config });
  const [command, ...args] = fakeServerCmd(script) as [string, ...string[]];
  const spec: ServerSpec = {
    definition: { ...TYPESCRIPT_SERVER_DEFINITION, ...(settings ? { settings } : {}) },
    command,
    args,
    source: 'override',
  };
  return { logFile, spec };
}

function newPool(opts: ConstructorParameters<typeof LspServerPool>[0] = {}): LspServerPool {
  const pool = new LspServerPool(opts);
  pools.push(pool);
  return pool;
}

function tsFile(name: string, content = 'const x = 1;\n'): string {
  const p = path.join(tempDir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const position = (uri: string) => ({ textDocument: { uri }, position: { line: 0, character: 0 } });

describe('LspServerPool', () => {
  it('reuses one warm server across two queries (one spawn)', async () => {
    const { logFile, spec } = setup({ locations: [] });
    const pool = newPool();
    const file = tsFile('reuse.ts');
    for (let i = 0; i < 2; i++) {
      const res = await withPooledFile(spec, file, 'const x = 1;\n', { root: tempDir, timeoutMs: 5000, pool },
        (ctx) => ctx.client.request('textDocument/definition', position(ctx.sync.uri), { timeoutMs: 2000 }));
      expect(res).toEqual([]);
    }
    expect(spawnCount(logFile)).toBe(1);
    expect(messagesWithMethod(logFile, 'initialize')).toHaveLength(1);
    expect(messagesWithMethod(logFile, 'textDocument/definition')).toHaveLength(2);
  }, 10_000);

  it('dedupes concurrent acquires into one start', async () => {
    const { logFile, spec } = setup();
    const pool = newPool();
    const [a, b, c] = await Promise.all([
      pool.acquire(spec, tempDir), pool.acquire(spec, tempDir), pool.acquire(spec, tempDir),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(pool.spawned).toBe(1);
    expect(spawnCount(logFile)).toBe(1);
  }, 10_000);

  it('evicts a crashed server and spawns a fresh one on the next acquire', async () => {
    const { logFile, spec } = setup({ crashOnRequest: true });
    const pool = newPool();
    const first = await pool.acquire(spec, tempDir);
    const err = await first.request('textDocument/definition', position('file:///x.ts'), { timeoutMs: 3000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LspClientError);
    expect((err as LspClientError).kind).toBe('exited');
    await until(() => !first.alive && pool.size === 0);
    const second = await pool.acquire(spec, tempDir);
    expect(second).not.toBe(first);
    expect(second.alive).toBe(true);
    expect(spawnCount(logFile)).toBe(2);
  }, 10_000);

  it('rejects (never hangs) when the server crashes on start', async () => {
    const { spec } = setup({ crashOnStart: true });
    const pool = newPool();
    const err = await pool.acquire(spec, tempDir, { timeoutMs: 3000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LspClientError);
    expect(pool.size).toBe(0);
  }, 10_000);

  it('rejects with spawn when the binary does not exist', async () => {
    const pool = newPool();
    const spec: ServerSpec = {
      definition: TYPESCRIPT_SERVER_DEFINITION, command: path.join(tempDir, 'no-such-binary-afk'),
      args: [], source: 'override',
    };
    const err = await pool.acquire(spec, tempDir, { timeoutMs: 3000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LspClientError);
    expect(['spawn', 'exited']).toContain((err as LspClientError).kind);
  }, 10_000);

  it('shuts an idle server down and respawns on the next acquire', async () => {
    const { logFile, spec } = setup();
    const pool = newPool({ idleShutdownMs: 100 });
    const client = await pool.acquire(spec, tempDir);
    await until(() => !client.alive && pool.size === 0);
    expect(messagesWithMethod(logFile, 'shutdown')).toHaveLength(1);
    const next = await pool.acquire(spec, tempDir);
    expect(next).not.toBe(client);
    expect(spawnCount(logFile)).toBe(2);
  }, 10_000);

  it('kills a start every acquirer abandoned after the grace window', async () => {
    const { spec } = setup({ silent: true });
    const pool = newPool({ abandonedStartGraceMs: 50 });
    const err = await pool.acquire(spec, tempDir, { timeoutMs: 100 }).catch((e: unknown) => e);
    expect((err as LspClientError).kind).toBe('timeout');
    await until(() => pool.size === 0);
  }, 10_000);

  it('reads the idle window from AFK_LSP_IDLE_SHUTDOWN_MS', () => {
    vi.stubEnv('AFK_LSP_IDLE_SHUTDOWN_MS', '1234');
    expect(getIdleShutdownMs()).toBe(1234);
    vi.stubEnv('AFK_LSP_IDLE_SHUTDOWN_MS', 'nope');
    expect(getIdleShutdownMs()).toBe(DEFAULT_LSP_IDLE_SHUTDOWN_MS);
  });
});

describe('LspClient', () => {
  it('abort sends $/cancelRequest, resolves promptly, and keeps the server usable', async () => {
    const { logFile, spec } = setup({ hangRequests: true });
    const pool = newPool();
    const client = await pool.acquire(spec, tempDir);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    const err = await client.request('textDocument/definition', position('file:///x.ts'), { signal: ac.signal })
      .catch((e: unknown) => e);
    expect((err as LspClientError).kind).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(2000);
    await until(() => messagesWithMethod(logFile, '$/cancelRequest').length === 1);
    expect(client.alive).toBe(true);
  }, 10_000);

  it('times out a hung request without killing the server', async () => {
    const { spec } = setup({ hangRequests: true });
    const client = await newPool().acquire(spec, tempDir);
    const err = await client.request('textDocument/references', position('file:///x.ts'), { timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect((err as LspClientError).kind).toBe('timeout');
    expect(client.alive).toBe(true);
  }, 10_000);

  it('answers workspace/configuration from definition.settings (null when missing)', async () => {
    const { logFile, spec } = setup({ configurationSections: ['python', 'missing'] }, { python: { analysis: 1 } });
    await newPool().acquire(spec, tempDir);
    await until(() => readFakeLog(logFile).some((e) => e.msg?.id === 'cfg-1'));
    const reply = readFakeLog(logFile).find((e) => e.msg?.id === 'cfg-1')!.msg!;
    expect(reply.result).toEqual([{ analysis: 1 }, null]);
  }, 10_000);

  it('sends didOpen once, then didChange with version++ only on content change', async () => {
    const { logFile, spec } = setup();
    const client = await newPool().acquire(spec, tempDir);
    const file = tsFile('sync.ts');
    expect((await client.syncFile(file, 'a'))?.version).toBe(1);
    expect((await client.syncFile(file, 'a'))?.changed).toBe(false);
    expect((await client.syncFile(file, 'b'))?.version).toBe(2);
    expect(await client.syncFile(path.join(tempDir, 'x.py'), 'p')).toBeNull();
    await until(() => messagesWithMethod(logFile, 'textDocument/didChange').length === 1);
    expect(messagesWithMethod(logFile, 'textDocument/didOpen')).toHaveLength(1);
    const change = messagesWithMethod(logFile, 'textDocument/didChange')[0]!;
    expect(change.params.textDocument.version).toBe(2);
    expect(change.params.contentChanges).toEqual([{ text: 'b' }]);
  }, 10_000);

  it('waits for version-matched diagnostics on a warm server after didChange', async () => {
    const diag = { severity: 1, message: 'boom', range: { start: { line: 0, character: 0 } } };
    const { spec } = setup({ diagnostics: [diag] });
    const pool = newPool();
    const file = tsFile('diag.ts');
    const run = (text: string) => withPooledFile(spec, file, text, { root: tempDir, timeoutMs: 3000, pool },
      async (ctx) => ({ version: ctx.sync.version, published: await awaitSyncDiagnostics(ctx) }));
    const first = await run('a');
    const second = await run('b');
    expect(first.published?.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.published?.version).toBe(2);
    expect(second.published?.diagnostics).toEqual([diag]);
    expect(pool.spawned).toBe(1);
  }, 10_000);
});

describe('#4293 review fixes', () => {
  it('dispose kills the server and its child tree and awaits exit (C-1)', async () => {
    const { logFile, spec } = setup({ spawnGrandchild: true });
    const pool = newPool();
    const client = await pool.acquire(spec, tempDir);
    await until(() => readFakeLog(logFile).some((e) => e.grandchild !== undefined));
    const pid = client.pid!;
    const grandchild = readFakeLog(logFile).find((e) => e.grandchild !== undefined)!.grandchild!;
    expect(pidAlive(pid)).toBe(true);
    await pool.disposeAll();
    // dispose resolved only after the root exited.
    expect(pidAlive(pid)).toBe(false);
    await until(() => !pidAlive(grandchild), 5000);
  }, 15_000);

  it('eviction (idle shutdown) leaves no live server process', async () => {
    const { spec } = setup();
    const pool = newPool({ idleShutdownMs: 50 });
    const client = await pool.acquire(spec, tempDir);
    const pid = client.pid!;
    await until(() => !client.alive);
    await client.dispose();
    expect(pidAlive(pid)).toBe(false);
  }, 10_000);

  it('the server cwd can be removed right after disposeAll (no EBUSY)', async () => {
    const root = path.join(tempDir, `cwd-${++counter}`);
    mkdirSync(root, { recursive: true });
    const { spec } = setup({ spawnGrandchild: true });
    const pool = newPool();
    await pool.acquire(spec, root);
    await pool.disposeAll();
    expect(() => rmSync(root, { recursive: true, force: true })).not.toThrow();
  }, 15_000);

  it('disposeAll waits for a still-starting server too', async () => {
    const { logFile, spec } = setup({ silent: true });
    const pool = newPool();
    const pending = pool.acquire(spec, tempDir).catch(() => null);
    await until(() => spawnCount(logFile) === 1);
    const pid = readFakeLog(logFile).find((e) => e.spawn !== undefined)!.spawn!;
    await pool.disposeAll();
    await pending;
    expect(pidAlive(pid)).toBe(false);
  }, 10_000);

  it('a late unversioned publish for an earlier edit is not reported for the current one (C-3)', async () => {
    const { spec } = setup({ echoText: true, publishVersion: false, publishDelays: { '1': 100, '2': 150 } });
    const client = await newPool().acquire(spec, tempDir);
    const file = tsFile('race.ts');
    await client.syncFile(file, 'old');
    const seq = client.diagnostics.seq;
    const sync = await client.syncFile(file, 'new');
    const published = await client.diagnostics.waitFor(sync!.uri, sync!.version, seq, 3000);
    expect(published?.diagnostics).toEqual([{ message: 'new' }]);
  }, 10_000);

  it('a previously queried file is didClosed when another file is queried (C-2)', async () => {
    const { logFile, spec } = setup({ echoText: true });
    const pool = newPool();
    const a = tsFile('closed-a.ts', 'a1');
    const b = tsFile('closed-b.ts', 'b1');
    const query = (file: string, text: string) => withPooledFile(spec, file, text, { root: tempDir, timeoutMs: 3000, pool },
      async (ctx) => ({ client: ctx.client, published: await awaitSyncDiagnostics(ctx) }));
    await query(a, 'a1');
    writeFileSync(a, 'a2-edited-elsewhere', 'utf8');
    const { client, published } = await query(b, 'b1');
    expect(published?.diagnostics).toEqual([{ message: 'b1' }]);
    const uriA = pathToFileURL(a).toString();
    await until(() => messagesWithMethod(logFile, 'textDocument/didClose').some((m) => m?.params.textDocument.uri === uriA));
    expect(client.openDocuments).toEqual([pathToFileURL(b).toString()]);
    // Re-querying A re-opens it with the fresh text (didOpen, not a stale didChange).
    const again = await query(a, 'a2-edited-elsewhere');
    expect(again.published?.diagnostics).toEqual([{ message: 'a2-edited-elsewhere' }]);
    expect(messagesWithMethod(logFile, 'textDocument/didOpen').filter((m) => m?.params.textDocument.uri === uriA)).toHaveLength(2);
  }, 10_000);
});

describe('DiagnosticsStore unversioned settle (C-3)', () => {
  it('returns the newest unversioned publish after the settle window', async () => {
    const store = new DiagnosticsStore(50);
    const seq = store.seq;
    const wait = store.waitFor('u', 2, seq, 2000);
    store.record({ uri: 'u', diagnostics: ['stale'] });
    store.record({ uri: 'u', diagnostics: ['fresh'] });
    expect((await wait)?.diagnostics).toEqual(['fresh']);
  });

  it('versioned publishes still match exactly and resolve immediately', async () => {
    const store = new DiagnosticsStore(10_000);
    const wait = store.waitFor('u', 2, store.seq, 2000);
    store.record({ uri: 'u', version: 1, diagnostics: ['old'] });
    store.record({ uri: 'u', version: 2, diagnostics: ['cur'] });
    const started = Date.now();
    expect((await wait)?.diagnostics).toEqual(['cur']);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never waits past the timeout: returns the candidate seen so far', async () => {
    const store = new DiagnosticsStore(10_000);
    const wait = store.waitFor('u', undefined, store.seq, 50);
    store.record({ uri: 'u', diagnostics: ['only'] });
    expect((await wait)?.diagnostics).toEqual(['only']);
  });
});
