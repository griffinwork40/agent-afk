/**
 * Scenario 2 (#3714): "Forward an idempotency key header where the remote
 * honors one."
 *
 * The effect-ledger pre-hook computes a deterministic idempotency key for
 * every mutating web_request call (POST/PATCH/PUT/DELETE), but currently
 * never injects it into the outbound request headers as `Idempotency-Key`.
 * This means that for remotes that honor the Idempotency-Key header
 * (Stripe, GitHub, many REST APIs), a second attempt after a lost response
 * re-applies the operation instead of being treated as a safe retry.
 *
 * The pre-hook already has the plumbing to rewrite the tool's input before
 * dispatch via `HookDecision.updatedInput` (hooks.ts:119-137). The computed
 * key is available inside `createEffectLedgerHooks` via `computeIdempotencyKey`
 * (idempotency.ts). The gap: the pre-hook never sets `updatedInput`.
 *
 * Tests:
 *   1. (passing) The pre-hook computes and records a deterministic key for
 *      mutating web_request calls — the seam exists (idempotency key is stored
 *      in the ledger record, same value every call with the same args).
 *   2. (it.fails) The pre-hook DOES NOT currently inject `Idempotency-Key`
 *      into `updatedInput.headers` — pins the defect so the suite flips green
 *      when the feature lands.
 *   3. (passing) GET/HEAD requests are not external effects and therefore
 *      receive no `updatedInput` rewrite — only mutating methods are affected.
 *   4. (passing) Idempotency key is stable: same method+url+body hash the same
 *      on every call, so a retry receives the same header value.
 *   5. (passing) If the caller already supplied an `Idempotency-Key` header,
 *      the pre-hook must not overwrite it — caller-supplied keys have priority.
 *      Currently true vacuously (no injection). When the feature lands, this
 *      test guards against clobbering explicit keys.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEffectLedgerHooks } from './hook.js';
import { computeIdempotencyKey } from './idempotency.js';
import { EffectStore } from './store.js';
import type { PreToolUseContext } from '../hooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function webRequestPre(
  method: string,
  url: string,
  extra: Record<string, unknown> = {},
  id = 'tu-1',
): PreToolUseContext {
  return {
    event: 'PreToolUse',
    toolName: 'web_request',
    input: { method, url, ...extra },
    sessionId: 'session-1',
    toolUseId: id,
  };
}

let dir: string;
let store: EffectStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'effect-ledger-idempotency-header-'));
  store = new EffectStore(join(dir, 'ledger.jsonl'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Seam exists: the hook records the deterministic key in the ledger
// ---------------------------------------------------------------------------

describe('Scenario 2 / #3714 — idempotency-key header forwarding', () => {
  it('pre-hook records a deterministic idempotency key for mutating web_request calls', async () => {
    const { pre } = createEffectLedgerHooks(store);
    const ctx = webRequestPre('POST', 'https://api.example.com/resources', { body: { name: 'foo' } });

    await pre(ctx);

    const records = await store.all();
    expect(records).toHaveLength(1);
    const record = records[0]!;

    // The ledger entry carries the computed key.
    const expectedKey = computeIdempotencyKey('web_request_mutation', ctx.input);
    expect(record.idempotencyKey).toBe(expectedKey);
    expect(record.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    // The key is stable across calls with identical inputs.
    const again = computeIdempotencyKey('web_request_mutation', ctx.input);
    expect(again).toBe(expectedKey);
  });

  // ── Defect pin (it.fails) ──────────────────────────────────────────────────

  // eslint-disable-next-line vitest/no-disabled-tests
  it.fails(
    'DEFECT(#3714): pre-hook does not yet inject Idempotency-Key header into updatedInput' +
      ' — flip to passing when header-forwarding is implemented',
    async () => {
      // When the feature is implemented, the pre-hook's HookDecision should
      // carry updatedInput with the Idempotency-Key header merged into any
      // caller-supplied headers, using the same key stored in the ledger.
      const { pre } = createEffectLedgerHooks(store);
      const ctx = webRequestPre('POST', 'https://api.example.com/resources', {}, 'tu-defect');

      const decision = await pre(ctx);

      // The hook must set updatedInput so the dispatcher rewrites the call's
      // headers before forwarding to the remote. Currently this field is
      // absent — the defect.
      expect(decision.updatedInput).toBeDefined();

      const headers = (decision.updatedInput as Record<string, unknown>)['headers'];
      expect(headers).toBeDefined();

      const expectedKey = computeIdempotencyKey('web_request_mutation', ctx.input);
      expect((headers as Record<string, string>)['Idempotency-Key']).toBe(expectedKey);
    },
  );

  // ── 3. GET/HEAD are non-external: no updatedInput rewrite ─────────────────

  it('GET and HEAD requests are not external effects and receive no updatedInput', async () => {
    const { pre } = createEffectLedgerHooks(store);

    const getDecision = await pre(webRequestPre('GET', 'https://api.example.com/resources', {}, 'tu-get'));
    const headDecision = await pre(webRequestPre('HEAD', 'https://api.example.com/resources', {}, 'tu-head'));

    // Non-external calls must not be rewritten.
    expect(getDecision.updatedInput).toBeUndefined();
    expect(headDecision.updatedInput).toBeUndefined();

    // And nothing is written to the ledger for reads.
    expect(await store.all()).toHaveLength(0);
  });

  // ── 4. Idempotency key is stable across retries ────────────────────────────

  it('the same method+url+body produces the same idempotency key on every call', () => {
    const input = { method: 'POST', url: 'https://api.example.com/orders', body: { item: 'widget', qty: 3 } };
    const k1 = computeIdempotencyKey('web_request_mutation', input);
    const k2 = computeIdempotencyKey('web_request_mutation', input);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);

    // Different methods produce different keys even with identical other fields.
    const k3 = computeIdempotencyKey('web_request_mutation', { ...input, method: 'PATCH' });
    expect(k3).not.toBe(k1);
  });

  // ── 5. Caller-supplied Idempotency-Key must not be clobbered ──────────────

  it('a caller-supplied Idempotency-Key header is not overwritten by the hook (vacuously true until feature lands)', async () => {
    // Currently the hook never sets updatedInput, so caller headers are
    // trivially preserved. When header-forwarding is implemented, the hook
    // must detect a pre-existing Idempotency-Key and leave it untouched.
    const { pre } = createEffectLedgerHooks(store);
    const callerKey = 'caller-supplied-key-abc123';
    const ctx = webRequestPre(
      'DELETE',
      'https://api.example.com/resources/42',
      { headers: { 'Idempotency-Key': callerKey } },
      'tu-caller-key',
    );

    const decision = await pre(ctx);

    // If updatedInput IS set (feature landed), verify the caller's key survives.
    if (decision.updatedInput !== undefined) {
      const headers = (decision.updatedInput as Record<string, unknown>)['headers'] as Record<string, string> | undefined;
      // The original caller key must not have been replaced.
      expect(headers?.['Idempotency-Key']).toBe(callerKey);
    }
    // If updatedInput is absent (current behavior), headers are untouched — pass.
  });
});
