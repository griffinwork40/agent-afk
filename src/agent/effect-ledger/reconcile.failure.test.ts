import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectStore } from './store.js';

let dir: string;
let store: EffectStore;
let id: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'effect-reconcile-'));
  store = new EffectStore(join(dir, 'ledger.jsonl'));
  id = store.writePending({ idempotencyKey: 'effect', operationType: 'gh_pr_create', args: {} }).id;
  await store.updateStatus({ id, status: 'unknown' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it.each(['negative', 'throw', 'missing-evidence'])('preserves unknown on %s read', async (mode) => {
  const record = await store.reconcile(id, async () => {
    if (mode === 'throw') throw new Error('read timed out');
    return { matched: mode !== 'negative', evidence: mode === 'missing-evidence' ? null : { unrelated: 1 } };
  });
  expect(record.status).toBe('unknown');
  expect(record.reconciledAt).toBeUndefined();
  expect((await new EffectStore(join(dir, 'ledger.jsonl')).all())[0]?.status).toBe('unknown');
});

it.each(['pending', 'executed', 'failed', 'confirmed', 'ambiguous'] as const)('does not probe or overwrite %s', async (status) => {
  if (status === 'pending') id = store.writePending({ idempotencyKey: 'pending', operationType: 'test', args: {} }).id;
  else await store.updateStatus({ id, status });
  const read = vi.fn();
  expect((await store.reconcile(id, read)).status).toBe(status);
  expect(read).not.toHaveBeenCalled();
});

it('does not overwrite a settlement made while the read is in flight', async () => {
  let release!: (value: { matched: boolean; evidence: unknown }) => void;
  const observation = new Promise<{ matched: boolean; evidence: unknown }>((resolve) => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const reconcile = store.reconcile(id, async () => { started(); return observation; });
  await reading;
  await new EffectStore(join(dir, 'ledger.jsonl')).updateStatus({ id, status: 'failed' });
  release({ matched: true, evidence: { pr: 42 } });
  expect((await reconcile).status).toBe('failed');
});

it('redacts read evidence and probes a detached copy', async () => {
  const result = await store.reconcile(id, async (record) => {
    (record.args as Record<string, unknown>)['modified'] = true;
    return { matched: true, evidence: { Authorization: 'Bearer sk-secretsecretsecretsecretsecret' } };
  });
  expect(result.args).toEqual({});
  expect(JSON.stringify(result.result)).not.toContain('sk-secretsecretsecretsecretsecret');
});

it('reconciles an acknowledged abandoned pending intent after restart', async () => {
  const abandoned = store.writePending({ idempotencyKey: 'crashed', operationType: 'gh_pr_create', args: { head: 'branch' } });
  const resumed = new EffectStore(join(dir, 'ledger.jsonl'));
  await resumed.acknowledgeRetry(abandoned.id);
  const result = await resumed.reconcile(abandoned.id, async () => ({ matched: true, evidence: { pr: 42 } }));
  expect(result.status).toBe('confirmed');
  expect(result.reconciledAt).toBeDefined();
  expect((await new EffectStore(join(dir, 'ledger.jsonl')).all()).find((record) => record.id === abandoned.id)).toEqual(result);
});

it('does not confirm oversized evidence', async () => {
  const result = await store.reconcile(id, async () => ({ matched: true, evidence: 'x '.repeat(65 * 1024) }));
  expect(result.status).toBe('unknown');
});

it('rejects missing ids without a remote read', async () => {
  const read = vi.fn();
  await expect(store.reconcile('missing', read)).rejects.toThrow('record not found');
  expect(read).not.toHaveBeenCalled();
});
