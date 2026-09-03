/**
 * Unit tests for EffectStore.
 *
 * Uses a temp file per test to avoid cross-test contamination. The redirected
 * AFK_HOME sentinel from redirect-paths-env.ts means real state is never
 * touched even if a test leaks a default-path store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectStore } from './store.js';

let tmpDir: string;
let ledgerPath: string;
let store: EffectStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'effect-ledger-test-'));
  ledgerPath = join(tmpDir, 'effect-ledger.jsonl');
  store = new EffectStore(ledgerPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writePending
// ---------------------------------------------------------------------------

describe('EffectStore.writePending', () => {
  it('returns a record with status "pending" and a UUID id', () => {
    const rec = store.writePending({
      idempotencyKey: 'k1',
      operationType: 'send_telegram',
      args: { message: 'hello' },
      sessionId: 'sess-1',
    });
    expect(rec.v).toBe(1);
    expect(rec.status).toBe('pending');
    expect(typeof rec.id).toBe('string');
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.idempotencyKey).toBe('k1');
    expect(rec.operationType).toBe('send_telegram');
    expect(rec.sessionId).toBe('sess-1');
    expect(rec.timestamp).toBeGreaterThan(0);
  });

  it('creates the file on first write', async () => {
    store.writePending({ idempotencyKey: 'k2', operationType: 'mcp_write', args: {} });
    const all = await store.all();
    expect(all).toHaveLength(1);
  });

  it('two pending writes produce two distinct ids', () => {
    const r1 = store.writePending({ idempotencyKey: 'k3', operationType: 'send_telegram', args: {} });
    const r2 = store.writePending({ idempotencyKey: 'k4', operationType: 'send_telegram', args: {} });
    expect(r1.id).not.toBe(r2.id);
  });
});

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

describe('EffectStore.updateStatus', () => {
  it('transitions a pending record to "executed"', async () => {
    const pending = store.writePending({
      idempotencyKey: 'k5',
      operationType: 'send_telegram',
      args: { message: 'hi' },
    });
    const updated = await store.updateStatus({
      id: pending.id,
      status: 'executed',
      result: { ok: true },
    });
    expect(updated.status).toBe('executed');
    expect(updated.result).toEqual({ ok: true });
    expect(updated.id).toBe(pending.id);
  });

  it('transitions to "failed"', async () => {
    const pending = store.writePending({
      idempotencyKey: 'k6',
      operationType: 'send_telegram',
      args: {},
    });
    const updated = await store.updateStatus({
      id: pending.id,
      status: 'failed',
      result: { error: 'network timeout' },
    });
    expect(updated.status).toBe('failed');
  });

  it('transitions to "ambiguous" and sets reconciledAt', async () => {
    const pending = store.writePending({
      idempotencyKey: 'k7',
      operationType: 'send_telegram',
      args: {},
    });
    const before = Date.now();
    const updated = await store.updateStatus({ id: pending.id, status: 'ambiguous' });
    const after = Date.now();
    expect(updated.status).toBe('ambiguous');
    expect(updated.reconciledAt).toBeGreaterThanOrEqual(before);
    expect(updated.reconciledAt).toBeLessThanOrEqual(after);
  });

  it('transitions to "confirmed" and sets reconciledAt', async () => {
    const pending = store.writePending({
      idempotencyKey: 'k8',
      operationType: 'send_telegram',
      args: {},
    });
    const updated = await store.updateStatus({ id: pending.id, status: 'confirmed' });
    expect(updated.status).toBe('confirmed');
    expect(updated.reconciledAt).toBeDefined();
  });

  it('throws if the id does not exist', async () => {
    await expect(
      store.updateStatus({ id: 'nonexistent-uuid', status: 'executed' }),
    ).rejects.toThrow('record not found');
  });

  it('last write wins on id-collapse: query returns the latest status', async () => {
    const pending = store.writePending({
      idempotencyKey: 'k9',
      operationType: 'send_telegram',
      args: {},
    });
    await store.updateStatus({ id: pending.id, status: 'executed' });
    const all = await store.all();
    // Only one record per id after collapse.
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('executed');
  });
});

// ---------------------------------------------------------------------------
// findByIdempotencyKey
// ---------------------------------------------------------------------------

describe('EffectStore.findByIdempotencyKey', () => {
  it('returns null when no record exists with that key', async () => {
    const result = await store.findByIdempotencyKey('missing-key');
    expect(result).toBeNull();
  });

  it('returns the record after writePending', async () => {
    store.writePending({ idempotencyKey: 'my-key', operationType: 'send_telegram', args: {} });
    const found = await store.findByIdempotencyKey('my-key');
    expect(found).not.toBeNull();
    expect(found?.idempotencyKey).toBe('my-key');
    expect(found?.status).toBe('pending');
  });

  it('returns updated status after updateStatus', async () => {
    const pending = store.writePending({
      idempotencyKey: 'my-key-2',
      operationType: 'send_telegram',
      args: {},
    });
    await store.updateStatus({ id: pending.id, status: 'executed' });
    const found = await store.findByIdempotencyKey('my-key-2');
    expect(found?.status).toBe('executed');
  });
});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

describe('EffectStore.query', () => {
  it('filters by sessionId', async () => {
    store.writePending({ idempotencyKey: 'a1', operationType: 'send_telegram', args: {}, sessionId: 'sess-A' });
    store.writePending({ idempotencyKey: 'a2', operationType: 'send_telegram', args: {}, sessionId: 'sess-B' });
    const results = await store.query({ sessionId: 'sess-A' });
    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe('sess-A');
  });

  it('filters by operationType', async () => {
    store.writePending({ idempotencyKey: 'b1', operationType: 'send_telegram', args: {} });
    store.writePending({ idempotencyKey: 'b2', operationType: 'mcp_write', args: {} });
    const results = await store.query({ operationType: 'mcp_write' });
    expect(results).toHaveLength(1);
    expect(results[0]?.operationType).toBe('mcp_write');
  });

  it('filters by status', async () => {
    const r1 = store.writePending({ idempotencyKey: 'c1', operationType: 'send_telegram', args: {} });
    const r2 = store.writePending({ idempotencyKey: 'c2', operationType: 'send_telegram', args: {} });
    await store.updateStatus({ id: r1.id, status: 'executed' });
    // r2 stays pending
    void r2;

    const pending = await store.query({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotencyKey).toBe('c2');

    const executed = await store.query({ status: 'executed' });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.idempotencyKey).toBe('c1');
  });

  it('filters by idempotencyKey', async () => {
    store.writePending({ idempotencyKey: 'd1', operationType: 'send_telegram', args: {} });
    store.writePending({ idempotencyKey: 'd2', operationType: 'send_telegram', args: {} });
    const results = await store.query({ idempotencyKey: 'd2' });
    expect(results).toHaveLength(1);
    expect(results[0]?.idempotencyKey).toBe('d2');
  });

  it('returns empty list from empty ledger', async () => {
    const results = await store.query();
    expect(results).toHaveLength(0);
  });

  it('ANDs multiple filters', async () => {
    store.writePending({ idempotencyKey: 'e1', operationType: 'send_telegram', args: {}, sessionId: 'sess-X' });
    store.writePending({ idempotencyKey: 'e2', operationType: 'mcp_write', args: {}, sessionId: 'sess-X' });
    const results = await store.query({ sessionId: 'sess-X', operationType: 'mcp_write' });
    expect(results).toHaveLength(1);
    expect(results[0]?.idempotencyKey).toBe('e2');
  });
});

// ---------------------------------------------------------------------------
// Malformed-line tolerance
// ---------------------------------------------------------------------------

describe('EffectStore — malformed-line tolerance', () => {
  it('skips malformed lines and returns valid records', async () => {
    // Write a valid record manually, then append garbage.
    const { writeFileSync } = await import('node:fs');
    const validRecord = JSON.stringify({
      v: 1,
      id: 'well-known-id',
      idempotencyKey: 'clean',
      operationType: 'send_telegram',
      args: {},
      status: 'pending',
      timestamp: Date.now(),
    });
    writeFileSync(ledgerPath, validRecord + '\nnot-json\n{"incomplete":\n');

    const results = await store.all();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('well-known-id');
  });
});
