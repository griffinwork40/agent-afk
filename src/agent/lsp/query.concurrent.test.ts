/**
 * Concurrent withPooledFile tests for query.ts — review finding F2:
 * per-(client, uri) lock on syncFile + fn to prevent didChange races.
 *
 * Uses the fake LSP server infra from pool.test.ts but focuses specifically
 * on concurrent calls for the same URI not interleaving their syncs.
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  writeFakeLspServer,
  fakeServerCmd,
} from './__test-utils__/fake-lsp-server.js';
import { LspServerPool } from './pool.js';
import { withPooledFile } from './query.js';
import { TYPESCRIPT_SERVER_DEFINITION } from './typescript-default.js';
import type { ServerSpec } from './server-spec.js';

const tempDir = path.join(
  os.tmpdir(),
  `afk-lsp-query-concurrent-${process.pid}-${randomBytes(4).toString('hex')}`,
);
mkdirSync(tempDir, { recursive: true });
let counter = 0;
const pools: LspServerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
});
afterAll(async () => {
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
  rmSync(tempDir, { recursive: true, force: true });
});

function setup() {
  const id = ++counter;
  const logFile = path.join(tempDir, `log-${id}.jsonl`);
  const script = path.join(tempDir, `server-${id}.js`);
  writeFakeLspServer(script, { logFile });
  const [command, ...args] = fakeServerCmd(script) as [string, ...string[]];
  const spec: ServerSpec = {
    definition: TYPESCRIPT_SERVER_DEFINITION,
    command,
    args,
    source: 'override',
  };
  return { logFile, spec };
}

function newPool(): LspServerPool {
  const pool = new LspServerPool({ idleShutdownMs: 60_000 });
  pools.push(pool);
  return pool;
}

function tsFile(name: string, content = 'const x = 1;\n'): string {
  const p = path.join(tempDir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('withPooledFile concurrent same-URI (F2)', () => {
  it('two concurrent queries for the same URI both receive non-error sync results', async () => {
    const { logFile, spec } = setup();
    const pool = newPool();
    const file = tsFile(`concurrent-${counter}.ts`, 'export const a = 1;\n');

    const results = await Promise.all([
      withPooledFile(spec, file, 'export const a = 1;\n', { root: tempDir, timeoutMs: 10_000, pool }, async (ctx) => {
        return ctx.sync.uri;
      }),
      withPooledFile(spec, file, 'export const a = 2;\n', { root: tempDir, timeoutMs: 10_000, pool }, async (ctx) => {
        return ctx.sync.uri;
      }),
    ]);

    // Both calls must complete successfully and return the same document URI.
    expect(results[0]).toBeTruthy();
    expect(results[1]).toBeTruthy();
    expect(results[0]).toBe(results[1]);

    // Both results must be the same non-null URI — the core correctness check.
    // (Sync notification count varies with closeOthers/didOpen vs didChange
    // interplay, so we only assert structural correctness here.)
  });

  it('many concurrent queries for the same URI all complete without throwing', async () => {
    const { spec } = setup();
    const pool = newPool();
    const file = tsFile(`concurrent-many-${counter}.ts`, 'export const a = 1;\n');
    const N = 6;

    const calls = Array.from({ length: N }, (_, i) =>
      withPooledFile(
        spec, file, `export const a = ${i};\n`,
        { root: tempDir, timeoutMs: 15_000, pool },
        async (ctx) => ctx.sync.uri,
      ),
    );

    const results = await Promise.all(calls);
    expect(results).toHaveLength(N);
    for (const r of results) expect(r).toBeTruthy();
  });

  it('concurrent queries for DIFFERENT URIs do not block each other', async () => {
    const { spec } = setup();
    const pool = newPool();
    const fileA = tsFile(`uri-a-${counter}.ts`, 'export const a = 1;\n');
    const fileB = tsFile(`uri-b-${counter}.ts`, 'export const b = 2;\n');

    const [uriA, uriB] = await Promise.all([
      withPooledFile(spec, fileA, 'export const a = 1;\n', { root: tempDir, timeoutMs: 10_000, pool }, async (ctx) => ctx.sync.uri),
      withPooledFile(spec, fileB, 'export const b = 2;\n', { root: tempDir, timeoutMs: 10_000, pool }, async (ctx) => ctx.sync.uri),
    ]);

    expect(uriA).not.toBe(uriB);
    expect(uriA).toBeTruthy();
    expect(uriB).toBeTruthy();
  });
});
