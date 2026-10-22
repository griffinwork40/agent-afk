/**
 * Failure-injection test for #3714 Scenario 2:
 * "External action succeeds remotely, but its response is lost."
 *
 * This file covers the reconciliation sub-item:
 *   "Reconciliation to 'confirmed' through a remote read (e.g. gh pr list
 *    for a PR create), currently reserved but unused."
 *
 * The gap: EffectStore.updateStatus() supports status='confirmed' and writes
 * reconciledAt, but no test verifies the full lifecycle transition:
 *
 *   writePending  →  updateStatus('unknown')  →  updateStatus('confirmed')
 *
 * This is the reconciliation path — an agent dispatches an external action
 * (e.g. gh pr create), loses the response (network cut), records the outcome
 * as 'unknown', later performs an out-of-band read (gh pr list) to verify the
 * PR actually landed, and promotes the record to 'confirmed'.
 *
 * Without this transition tested:
 *   - A bug that ignores reconciledAt on the confirmed transition would be
 *     invisible.
 *   - A regression that overwrites confirmed→unknown on a retry would be
 *     invisible.
 *   - The dedup gate (hook.ts:110) that allows confirmed records to pass
 *     without blocking is untested end-to-end at the store layer.
 *
 * Suite rules: local, deterministic, no model calls, no network, no sleeps.
 *
 * @module agent/effect-ledger/store.reconcile.test
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
  tmpDir = mkdtempSync(join(tmpdir(), 'effect-ledger-reconcile-'));
  ledgerPath = join(tmpDir, 'effect-ledger.jsonl');
  store = new EffectStore(ledgerPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 2: unknown → confirmed (reconciliation lifecycle)
// ---------------------------------------------------------------------------

describe('EffectStore — Scenario 2 reconciliation: unknown → confirmed (#3714)', () => {
  /**
   * Core reconciliation path:
   *   writePending → unknown (response lost) → confirmed (out-of-band read)
   *
   * This is the full three-state lifecycle for a lost-response external
   * action. The store must accept the confirmed transition and stamp
   * reconciledAt on it.
   */
  it('transitions unknown → confirmed and stamps reconciledAt', async () => {
    const pending = store.writePending({
      idempotencyKey: 'ik-reconcile-1',
      operationType: 'bash_external',
      args: { command: 'gh pr create --title "feat: x"' },
      sessionId: 'sess-reconcile-1',
    });
    expect(pending.status).toBe('pending');

    // Response was lost — record the outcome as unknown.
    const unknown = await store.updateStatus({ id: pending.id, status: 'unknown' });
    expect(unknown.status).toBe('unknown');
    expect(unknown.reconciledAt).toBeUndefined();

    const before = Date.now();
    // Out-of-band read confirmed the PR exists — promote to confirmed.
    const confirmed = await store.updateStatus({
      id: pending.id,
      status: 'confirmed',
      result: { pr: 42, url: 'https://github.com/org/repo/pull/42' },
    });
    const after = Date.now();

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.reconciledAt).toBeGreaterThanOrEqual(before);
    expect(confirmed.reconciledAt).toBeLessThanOrEqual(after);
    expect(confirmed.result).toMatchObject({ pr: 42 });
  });

  /**
   * Query after reconciliation: confirmed records are findable by status.
   * The hook dedup gate (hook.ts:110) uses store.query({idempotencyKey})
   * and checks status === 'confirmed' to allow a retry through without
   * blocking. This test verifies the query layer exposes the confirmed record.
   */
  it('confirmed record is queryable by status after reconciliation', async () => {
    const p1 = store.writePending({
      idempotencyKey: 'ik-reconcile-2a',
      operationType: 'bash_external',
      args: { command: 'gh pr create' },
    });
    const p2 = store.writePending({
      idempotencyKey: 'ik-reconcile-2b',
      operationType: 'send_telegram',
      args: { message: 'hi' },
    });

    // p1 reconciled; p2 remains unknown.
    await store.updateStatus({ id: p1.id, status: 'unknown' });
    await store.updateStatus({ id: p1.id, status: 'confirmed' });
    await store.updateStatus({ id: p2.id, status: 'unknown' });

    const confirmedList = await store.query({ status: 'confirmed' });
    expect(confirmedList).toHaveLength(1);
    expect(confirmedList[0]?.idempotencyKey).toBe('ik-reconcile-2a');

    const unknownList = await store.query({ status: 'unknown' });
    expect(unknownList).toHaveLength(1);
    expect(unknownList[0]?.idempotencyKey).toBe('ik-reconcile-2b');
  });

  /**
   * Idempotency key lookup after reconciliation: the hook layer uses
   *   store.findByIdempotencyKey(key)
   * to decide whether to block a retry. After reconciliation the record
   * must be findable by its key with status='confirmed'.
   */
  it('findByIdempotencyKey returns confirmed record after reconciliation', async () => {
    const key = 'ik-reconcile-3';
    const pending = store.writePending({
      idempotencyKey: key,
      operationType: 'bash_external',
      args: { command: 'git push origin main' },
    });
    await store.updateStatus({ id: pending.id, status: 'unknown' });
    await store.updateStatus({ id: pending.id, status: 'confirmed' });

    const found = await store.findByIdempotencyKey(key);
    expect(found).not.toBeNull();
    expect(found!.status).toBe('confirmed');
    expect(found!.reconciledAt).toBeDefined();
  });

  /**
   * reconciledAt is NOT set on the unknown transition — only on confirmed
   * (and ambiguous). This pins the contract so a future change that
   * accidentally stamps reconciledAt on unknown is caught.
   */
  it('reconciledAt is undefined after unknown transition, defined after confirmed', async () => {
    const pending = store.writePending({
      idempotencyKey: 'ik-reconcile-4',
      operationType: 'bash_external',
      args: { command: 'gh pr create' },
    });

    const unknown = await store.updateStatus({ id: pending.id, status: 'unknown' });
    expect(unknown.reconciledAt).toBeUndefined();

    const confirmed = await store.updateStatus({ id: pending.id, status: 'confirmed' });
    expect(confirmed.reconciledAt).toBeDefined();
  });

  /**
   * Confirmed records preserve their original idempotencyKey, operationType,
   * sessionId, and args across the full lifecycle. This guards against a
   * regression where updateStatus overwrites fields it should not touch.
   */
  it('confirmed record preserves identity fields from the original pending write', async () => {
    const pending = store.writePending({
      idempotencyKey: 'ik-reconcile-5',
      operationType: 'bash_external',
      args: { command: 'gh pr create --draft' },
      sessionId: 'sess-reconcile-5',
      taskId: 'task-42',
    });

    await store.updateStatus({ id: pending.id, status: 'unknown' });
    const confirmed = await store.updateStatus({ id: pending.id, status: 'confirmed' });

    expect(confirmed.id).toBe(pending.id);
    expect(confirmed.idempotencyKey).toBe('ik-reconcile-5');
    expect(confirmed.operationType).toBe('bash_external');
    expect(confirmed.sessionId).toBe('sess-reconcile-5');
    expect(confirmed.taskId).toBe('task-42');
    expect(confirmed.args).toEqual({ command: 'gh pr create --draft' });
  });

  /**
   * Pin: store.all() after a full lifecycle contains exactly one collapsed
   * record per id (last-write-wins), not three separate rows for the three
   * status transitions.
   */
  it('store.all() collapses the full lifecycle to a single confirmed record per id', async () => {
    const pending = store.writePending({
      idempotencyKey: 'ik-reconcile-6',
      operationType: 'bash_external',
      args: { command: 'gh pr create' },
    });
    await store.updateStatus({ id: pending.id, status: 'unknown' });
    await store.updateStatus({ id: pending.id, status: 'confirmed' });

    const all = await store.all();
    // Three lines were appended (pending, unknown, confirmed) but collapse
    // returns one record per id.
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('confirmed');
  });

  /**
   * Status-quo pin: there is currently no reconcile() helper method on
   * EffectStore — callers must call updateStatus({status:'confirmed'})
   * directly. This pin documents that the reserved reconcile path is
   * currently a manual two-step (query + updateStatus), not an encapsulated
   * method. It flips naturally when a reconcile() API is added.
   *
   * KNOWN GAP (#3714 Scenario 2): a dedicated reconcile() method that
   * accepts a remote-read result and atomically transitions unknown→confirmed
   * does not exist. Callers must wire this manually.
   */
  it('status-quo pin: no reconcile() method on EffectStore [known gap]', () => {
    // EffectStore exposes: writePending, updateStatus, acknowledgeRetry,
    // findByIdempotencyKey, query, all — no reconcile() encapsulation yet.
    expect(typeof (store as unknown as Record<string, unknown>)['reconcile']).toBe('undefined');
  });
});
