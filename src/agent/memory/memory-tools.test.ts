/**
 * Tests for the memory_update hot-memory handler — the truncation-covenant
 * budget signal.
 *
 * The store-level truncation behavior is covered in `memory-store.test.ts`;
 * this file pins the HANDLER contract: a normal hot write reports usage, a
 * write at/above the soft-warn threshold attaches a warning, and an over-cap
 * write succeeds (never throws) with a truncation note pointing at the fact
 * archive.
 *
 * @module agent/memory/memory-tools.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryStore } from './memory-store.js';
import { createMemoryHandlers } from './memory-tools.js';
import type { ToolHandler } from '../tools/types.js';

let tmpDir: string;
let store: MemoryStore;
let update: ToolHandler;

const signal = new AbortController().signal;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-memory-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  store = new MemoryStore(tmpDir);
  update = createMemoryHandlers(store, 'sess-1', 'test').get('memory_update')!;
});

afterEach(() => {
  store.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

async function hotSet(content: string): Promise<Record<string, unknown>> {
  const res = await update({ target: 'hot', action: 'set', content }, signal);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content) as Record<string, unknown>;
}

describe('memory_update — hot memory budget signal', () => {
  it('reports usage on a normal hot write (no warning, no truncation)', async () => {
    const parsed = await hotSet('# identity: Griffin — prefers pnpm');
    expect(parsed['saved']).toBe(true);
    expect(parsed['target']).toBe('hot');
    const usage = parsed['usage'] as Record<string, unknown>;
    expect(usage['maxTokens']).toBe(1500);
    expect(typeof usage['pct']).toBe('number');
    expect(parsed['truncated']).toBeUndefined();
    expect(parsed['warning']).toBeUndefined();
  });

  it('attaches a soft warning at/above 80% of the cap', async () => {
    const parsed = await hotSet('a'.repeat(4500)); // ~86% of 5250
    const usage = parsed['usage'] as Record<string, unknown>;
    expect(parsed['truncated']).toBeUndefined();
    expect(usage['pct'] as number).toBeGreaterThanOrEqual(80);
    expect(typeof parsed['warning']).toBe('string');
    expect(parsed['warning'] as string).toContain('fact archive');
  });

  it('over-cap write succeeds (no throw) with a truncation note → fact archive', async () => {
    const parsed = await hotSet('a'.repeat(6000));
    expect(parsed['saved']).toBe(true);
    expect(parsed['truncated']).toBe(true);
    expect(parsed['note'] as string).toContain('target:"fact"');
    expect(store.loadHot()!.length).toBeLessThanOrEqual(5250);
  });

  it('rejects a hot write with action other than "set"', async () => {
    const res = await update(
      { target: 'hot', action: 'supersede', content: 'x' },
      signal,
    );
    expect(res.isError).toBe(true);
  });
});
