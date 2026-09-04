/**
 * Unit tests for createStateHandlers — the tool-handler factory that wraps
 * StateStore behind the five MCP tool endpoints (state_get, state_put,
 * state_cas, state_delete, state_query).
 *
 * Each test runs against a fresh temporary database so they are fully
 * isolated from one another and from the real ~/.afk state.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolHandler } from '../tools/types.js';
import { StateStore } from './state-store.js';
import { createStateHandlers } from './state-tools.js';

// ── Shared setup/teardown ────────────────────────────────────────────────────

let tmpDir: string;
let store: StateStore;
let handlers: Map<string, ToolHandler>;

// A dummy AbortSignal that never fires — passed to every handler call.
const noopSignal = new AbortController().signal;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'state-tools-test-'));
  store = new StateStore(join(tmpDir, 'test.db'));
  handlers = createStateHandlers(store, 'test-session');
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed — ignore
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Invoke a named handler and parse its JSON content. */
async function call(name: string, input: unknown): Promise<{ raw: Awaited<ReturnType<ToolHandler>>; parsed: unknown }> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler registered for "${name}"`);
  const raw = await handler(input, noopSignal);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw.content);
  } catch {
    parsed = raw.content;
  }
  return { raw, parsed };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createStateHandlers', () => {
  it('state_get on missing key returns null content', async () => {
    const { raw, parsed } = await call('state_get', {
      namespace: 'ns',
      key: 'missing',
    });

    expect(raw.isError).toBeFalsy();
    expect(parsed).toBeNull();
  });

  it('state_put → state_get call-through; correct version shape', async () => {
    const putResult = await call('state_put', {
      namespace: 'ns',
      key: 'doc1',
      value: { hello: 'world' },
    });

    expect(putResult.raw.isError).toBeFalsy();
    expect(putResult.parsed).toMatchObject({ version: 1, created: true });

    const getResult = await call('state_get', { namespace: 'ns', key: 'doc1' });
    expect(getResult.raw.isError).toBeFalsy();
    const doc = getResult.parsed as { key: string; value: unknown; version: number };
    expect(doc.version).toBe(1);
    expect(doc.value).toEqual({ hello: 'world' });
  });

  it('state_cas mismatch returns {matched:false} in response content', async () => {
    // Insert the document first (version=1).
    await call('state_put', { namespace: 'ns', key: 'cas-doc', value: { v: 1 } });

    // CAS with wrong expected_version (99 ≠ 1).
    const casResult = await call('state_cas', {
      namespace: 'ns',
      key: 'cas-doc',
      expected_version: 99,
      value: { v: 'hijacked' },
    });

    expect(casResult.raw.isError).toBeFalsy();
    expect(casResult.parsed).toEqual({ matched: false });

    // Original document is unchanged.
    const getResult = await call('state_get', { namespace: 'ns', key: 'cas-doc' });
    const doc = getResult.parsed as { version: number; value: unknown };
    expect(doc.version).toBe(1);
    expect(doc.value).toEqual({ v: 1 });
  });

  it('state_delete removes document', async () => {
    await call('state_put', { namespace: 'ns', key: 'to-delete', value: 42 });

    const delResult = await call('state_delete', {
      namespace: 'ns',
      key: 'to-delete',
    });
    expect(delResult.raw.isError).toBeFalsy();
    expect(delResult.parsed).toEqual({ deleted: true });

    // Subsequent get must return null.
    const getResult = await call('state_get', { namespace: 'ns', key: 'to-delete' });
    expect(getResult.parsed).toBeNull();
  });

  it('state_query with prefix filter returns only matching keys', async () => {
    await call('state_put', { namespace: 'qns', key: 'alpha-1', value: 1 });
    await call('state_put', { namespace: 'qns', key: 'alpha-2', value: 2 });
    await call('state_put', { namespace: 'qns', key: 'beta-1', value: 3 });

    const result = await call('state_query', {
      namespace: 'qns',
      key_prefix: 'alpha',
    });

    const rows = result.parsed as Array<{ key: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.key.startsWith('alpha'))).toBe(true);
  });

  it('invalid namespace in state_put returns isError:true without throwing', async () => {
    const result = await call('state_put', {
      namespace: 'bad/name',
      key: 'key',
      value: { x: 1 },
    });

    // Handler must not throw; it must return isError:true.
    expect(result.raw.isError).toBe(true);
    // Content should describe what went wrong (Zod validation error).
    expect(typeof result.raw.content).toBe('string');
    expect(result.raw.content.length).toBeGreaterThan(0);
  });

  it('sessionId is recorded as producer after state_put', async () => {
    await call('state_put', { namespace: 'ns', key: 'produced', value: { ok: true } });

    // Inspect the raw SQLite row — StateStore doesn't expose producer via get(),
    // so we reach into the DB directly with a read-only connection.
    const dbPath = join(tmpDir, 'test.db');
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw
        .prepare<[string, string], { producer: string | null }>(
          `SELECT producer FROM state_documents WHERE namespace = ? AND key = ?`,
        )
        .get('ns', 'produced');

      expect(row).not.toBeNull();
      expect(row!.producer).toBe('test-session');
    } finally {
      raw.close();
    }
  });

  it('limit capped at 100 for state_query', async () => {
    // Insert 5 documents.
    for (let i = 1; i <= 5; i++) {
      await call('state_put', {
        namespace: 'capns',
        key: `doc-${String(i).padStart(2, '0')}`,
        value: { i },
      });
    }

    // The Zod schema enforces the 100-document ceiling: limit > 100 is a
    // validation error, not a silent clamp.  Confirm that limit:200 is
    // rejected at the handler boundary.
    const overCapResult = await call('state_query', {
      namespace: 'capns',
      limit: 200,
    });
    expect(overCapResult.raw.isError).toBe(true);

    // A request at exactly the cap (limit:100) must succeed and return all 5
    // documents — confirming the cap is enforced without rejecting valid inputs.
    const atCapResult = await call('state_query', {
      namespace: 'capns',
      limit: 100,
    });
    expect(atCapResult.raw.isError).toBeFalsy();
    const rows = atCapResult.parsed as unknown[];
    expect(rows).toHaveLength(5);
  });

  it('negative ttl_ms in state_put is rejected with isError:true', async () => {
    const result = await call('state_put', {
      namespace: 'ns',
      key: 'neg-ttl',
      value: { x: 1 },
      ttl_ms: -1,
    });
    expect(result.raw.isError).toBe(true);
  });

  it('non-integer ttl_ms in state_put is rejected with isError:true', async () => {
    const result = await call('state_put', {
      namespace: 'ns',
      key: 'float-ttl',
      value: { x: 1 },
      ttl_ms: 100.5,
    });
    expect(result.raw.isError).toBe(true);
  });
});
