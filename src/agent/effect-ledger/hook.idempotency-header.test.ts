// Scenario 2 (#3714): explicit remote capability, durable retry identity, no network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEffectLedgerHooks } from './hook.js';
import { EffectStore } from './store.js';
import type { PreToolUseContext } from '../hooks.js';

let dir: string;
let store: EffectStore;
function context(extra: Record<string, unknown> = {}, id = 'first'): PreToolUseContext {
  return {
    event: 'PreToolUse', toolName: 'web_request', sessionId: 'session', toolUseId: id,
    input: { method: 'POST', url: 'https://example.test/orders', remote_idempotency: true, ...extra },
  };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'effect-header-'));
  store = new EffectStore(join(dir, 'ledger.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Scenario 2 / #3714 — remote idempotency forwarding', () => {
  it('forwards and persists a key before dispatch without mutating caller headers', async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Trace': 'trace' };
    const ctx = context({ headers });
    const decision = await createEffectLedgerHooks(store).pre(ctx);
    expect(decision.updatedInput?.['headers']).toEqual({ ...headers, 'Idempotency-Key': expect.any(String) });
    expect(headers).not.toHaveProperty('Idempotency-Key');
    const rows = await new EffectStore(join(dir, 'ledger.jsonl')).all();
    expect(rows[0]?.remoteIdempotencyKey).toBe((decision.updatedInput?.['headers'] as Record<string, string>)['Idempotency-Key']);
    expect(rows[0]?.status).toBe('pending');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('preserves caller key case-insensitively for %s', async (method) => {
    const headers = { 'iDeMpOtEnCy-KeY': 'caller-key', Other: 'value' };
    const decision = await createEffectLedgerHooks(store).pre(context({ method, headers }));
    expect(decision.updatedInput?.['headers']).toEqual(headers);
    expect((await store.all())[0]?.remoteIdempotencyKey).toBe('caller-key');
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not rewrite read-only %s', async (method) => {
    expect((await createEffectLedgerHooks(store).pre(context({ method }))).updatedInput).toBeUndefined();
    expect(await store.all()).toHaveLength(0);
  });

  it.each([false, undefined, 'true'])('does not infer remote support from opt-in %s', async (optIn) => {
    const result = await createEffectLedgerHooks(store).pre(context({ remote_idempotency: optIn }));
    expect(result.updatedInput).toBeUndefined();
    expect((await store.all())[0]?.remoteIdempotencyKey).toBeUndefined();
  });

  it('reuses the key after lost response and restart; intentional repeats get fresh keys', async () => {
    const ctx = context();
    const hooks = createEffectLedgerHooks(store);
    const first = await hooks.pre(ctx);
    await hooks.post({ ...ctx, event: 'PostToolUseFailure', input: first.updatedInput, error: 'response lost' });
    const resumed = createEffectLedgerHooks(new EffectStore(join(dir, 'ledger.jsonl')));
    expect((await resumed.pre(context({}, 'blocked'))).decision).toBe('block');
    const retry = await resumed.pre(context({}, 'retry'));
    expect(retry.updatedInput?.['headers']).toEqual(first.updatedInput?.['headers']);
    await resumed.post({ ...context({}, 'retry'), event: 'PostToolUse', input: retry.updatedInput, output: '{"status":200}' });
    const repeat = await resumed.pre(context({}, 'repeat'));
    expect(repeat.injectContext).toContain('identical external action');
    expect(repeat.updatedInput?.['headers']).not.toEqual(first.updatedInput?.['headers']);
    const separate = await resumed.pre({ ...context({}, 'independent'), sessionId: 'other-session' });
    expect(separate.updatedInput?.['headers']).not.toEqual(first.updatedInput?.['headers']);
    const rows = await new EffectStore(join(dir, 'ledger.jsonl')).all();
    expect(rows.map((row) => row.status)).toEqual(['unknown', 'executed', 'pending', 'pending']);
    expect(rows[1]?.retryOf).toBe(rows[0]?.id);
  });
});
