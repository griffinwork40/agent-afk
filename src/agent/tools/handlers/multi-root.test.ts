/**
 * Multi-root containment tests.
 *
 * Verifies that read-class and write-class tools allow access to paths in
 * ANY allowed root and reject paths in roots that are not listed.
 *
 * @module agent/tools/handlers/multi-root.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileHandler } from './read-file.js';
import { writeFileHandler } from './write-file.js';
import { globHandler } from './glob.js';
import { listDirectoryHandler } from './list-directory.js';
import type { ToolHandlerContext } from '../types.js';

let rootA: string;
let rootB: string;
let rootC: string;

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), 'mr-a-'));
  rootB = mkdtempSync(join(tmpdir(), 'mr-b-'));
  rootC = mkdtempSync(join(tmpdir(), 'mr-c-'));

  // Seed files
  writeFileSync(join(rootA, 'a.txt'), 'content-a');
  writeFileSync(join(rootB, 'b.txt'), 'content-b');
  writeFileSync(join(rootC, 'c.txt'), 'content-c');
});

afterEach(() => {
  for (const r of [rootA, rootB, rootC]) {
    if (existsSync(r)) rmSync(r, { recursive: true, force: true });
  }
});

const sig = () => new AbortController().signal;

describe('multi-root containment — read_file', () => {
  it('allows path inside rootA when readRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      readRoots: [rootA, rootB],
    };
    const result = await readFileHandler({ file_path: join(rootA, 'a.txt') }, sig(), ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('content-a');
  });

  it('allows path inside rootB when readRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      readRoots: [rootA, rootB],
    };
    const result = await readFileHandler({ file_path: join(rootB, 'b.txt') }, sig(), ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('content-b');
  });

  it('rejects path inside rootC when readRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      readRoots: [rootA, rootB],
    };
    const result = await readFileHandler({ file_path: join(rootC, 'c.txt') }, sig(), ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed read roots/);
  });

  it('uses cwd as back-compat fallback root', async () => {
    const ctx: ToolHandlerContext = { cwd: rootA };
    const result = await readFileHandler({ file_path: join(rootA, 'a.txt') }, sig(), ctx);
    expect(result.isError).toBeFalsy();
  });
});

describe('multi-root containment — write_file', () => {
  it('allows write inside rootA when writeRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      writeRoots: [rootA, rootB],
    };
    const target = join(rootA, 'new.txt');
    const result = await writeFileHandler({ file_path: target, content: 'hello' }, sig(), ctx);
    expect(result.isError).toBeFalsy();
  });

  it('allows write inside rootB when writeRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      writeRoots: [rootA, rootB],
    };
    const target = join(rootB, 'new.txt');
    const result = await writeFileHandler({ file_path: target, content: 'hello' }, sig(), ctx);
    expect(result.isError).toBeFalsy();
  });

  it('rejects write inside rootC when writeRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      writeRoots: [rootA, rootB],
    };
    const target = join(rootC, 'new.txt');
    const result = await writeFileHandler({ file_path: target, content: 'hello' }, sig(), ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed write roots/);
  });
});

describe('multi-root containment — glob', () => {
  it('allows glob inside rootB when readRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      readRoots: [rootA, rootB],
    };
    const result = await globHandler({ pattern: '*.txt', path: rootB }, sig(), ctx);
    expect(result.isError).toBeFalsy();
  });

  it('rejects glob inside rootC when readRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      readRoots: [rootA, rootB],
    };
    const result = await globHandler({ pattern: '*.txt', path: rootC }, sig(), ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed read roots/);
  });
});

describe('multi-root containment — list_directory', () => {
  it('allows list inside rootB when readRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      readRoots: [rootA, rootB],
    };
    const result = await listDirectoryHandler({ path: rootB }, sig(), ctx);
    expect(result.isError).toBeFalsy();
  });

  it('rejects list inside rootC when readRoots = [rootA, rootB]', async () => {
    const ctx: ToolHandlerContext = {
      resolveBase: rootA,
      readRoots: [rootA, rootB],
    };
    const result = await listDirectoryHandler({ path: rootC }, sig(), ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed read roots/);
  });
});
