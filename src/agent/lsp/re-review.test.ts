import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFile } from '../../utils/atomic-write.js';
import { LspServerPool } from './pool.js';
import { withPooledFile, awaitSyncDiagnostics } from './query.js';
import { TYPESCRIPT_SERVER_DEFINITION } from './typescript-default.js';
import type { ServerSpec } from './server-spec.js';
import * as processHelpers from './client-process.js';
import { writeFakeLspServer, messagesWithMethod, readFakeLog, pidAlive, type FakeServerConfig } from './__test-utils__/fake-lsp-server.js';

const roots: string[] = [];
const pools: LspServerPool[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(config: FakeServerConfig = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-review-'));
  roots.push(root);
  const logFile = path.join(root, 'log.jsonl');
  const script = path.join(root, 'server.cjs');
  writeFakeLspServer(script, { ...config, logFile });
  const spec: ServerSpec = { definition: TYPESCRIPT_SERVER_DEFINITION,
    command: process.execPath, args: [script], source: 'override' };
  const pool = new LspServerPool();
  pools.push(pool);
  return { root, logFile, spec, pool };
}

const position = (uri: string) => ({ textDocument: { uri }, position: { line: 0, character: 0 } });
describe('#4293 re-review integration', () => {
  it('initialize advertises publishDiagnostics.versionSupport', async () => {
    const { pool, spec, root, logFile } = setup();
    await pool.acquire(spec, root);
    expect(messagesWithMethod(logFile, 'initialize')[0]?.params.capabilities.textDocument.publishDiagnostics.versionSupport).toBe(true);
  });

  it('closes stale A before querying B so cross-file answers read updated disk text', async () => {
    const s = setup();
    const a = path.join(s.root, 'a.ts');
    const b = path.join(s.root, 'b.ts');
    const uriA = pathToFileURL(a).toString();
    atomicWriteFile(a, 'old symbol');
    atomicWriteFile(b, 'import symbol');
    // Reconfigure before the server is started.
    writeFakeLspServer(path.join(s.root, 'server.cjs'), { logFile: s.logFile, readFileUri: uriA });
    const query = (file: string, text: string) => withPooledFile(s.spec, file, text,
      { root: s.root, pool: s.pool, timeoutMs: 5000 },
      (ctx) => ctx.client.request('textDocument/definition', position(ctx.sync.uri), { timeoutMs: ctx.remainingMs() }));
    expect(await query(a, 'old symbol')).toEqual([{ text: 'old symbol' }]);
    atomicWriteFile(a, 'new symbol');
    expect(await query(b, 'import symbol')).toEqual([{ text: 'new symbol' }]);
    const methods = readFakeLog(s.logFile).map((e) => e.msg?.method).filter(Boolean);
    expect(methods.indexOf('textDocument/didClose')).toBeLessThan(methods.lastIndexOf('textDocument/definition'));
  });

  it('pre-query close respects another in-flight useDocument hold', async () => {
    const { pool, spec, root } = setup();
    const client = await pool.acquire(spec, root);
    const a = path.join(root, 'held.ts');
    const sync = await client.syncFile(a, 'held');
    const release = client.useDocument(sync!.uri);
    try {
      await withPooledFile(spec, path.join(root, 'other.ts'), 'other', { root, pool, timeoutMs: 5000 }, async (ctx) => {
        expect(ctx.client.openDocuments).toContain(sync!.uri);
      });
    } finally { release(); }
    client.closeOthers(pathToFileURL(path.join(root, 'other.ts')).toString());
    expect(client.openDocuments).not.toContain(sync!.uri);
  });

  it('reopen rejects a delayed old-version publish and returns current diagnostics', async () => {
    const { pool, spec, root } = setup({ echoText: true, publishDelays: { '1': 150, '2': 350 } });
    const client = await pool.acquire(spec, root);
    const file = path.join(root, 'reopen.ts');
    await client.syncFile(file, 'old');
    client.closeOthers('file:///keep');
    const result = await withPooledFile(spec, file, 'new', { root, pool, timeoutMs: 5000 },
      async (ctx) => ({ version: ctx.sync.version, published: await awaitSyncDiagnostics(ctx) }));
    expect(result.version).toBe(2);
    expect(result.published?.diagnostics).toEqual([{ message: 'new' }]);
  });

  it('dispose awaits the tree walk before EOF and kills an EOF-exiting server child', async () => {
    const { pool, spec, root, logFile } = setup({ spawnGrandchild: true });
    const client = await pool.acquire(spec, root);
    const grandchild = readFakeLog(logFile).find((e) => e.grandchild !== undefined)!.grandchild!;
    const original = processHelpers.killServerTreeAndWait;
    let complete!: () => void;
    const walk = new Promise<void>((resolve) => { complete = resolve; });
    const spy = vi.spyOn(processHelpers, 'killServerTreeAndWait').mockImplementation(async (...args) => {
      await walk;
      return original(...args);
    });
    const disposing = client.dispose();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    // The fixture exits immediately on stdin EOF. A deferred tree walk must
    // not allow EOF to orphan its long-lived child, on any platform.
    await new Promise((r) => setTimeout(r, 100));
    const aliveDuringWalk = pidAlive(client.pid!);
    complete();
    await disposing;
    expect(aliveDuringWalk).toBe(true);
    expect(pidAlive(client.pid!)).toBe(false);
    await vi.waitFor(() => expect(pidAlive(grandchild)).toBe(false), { timeout: 5000 });
  }, 15_000);
});
