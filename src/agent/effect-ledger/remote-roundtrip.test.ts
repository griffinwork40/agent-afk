// Real dispatcher + HTTP handler, injected local fetch/DNS; no network or model.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionToolDispatcher } from '../tools/dispatcher.js';
import { createHookRegistry } from '../hook-registry.js';
import { webRequestTool } from '../tools/schemas.web-tools.js';
import { createWebRequestHandler } from '../tools/handlers/web-request.js';
import { createEffectLedgerHooks } from './hook.js';
import { EffectStore } from './store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('lost response is not auto-retried; explicit retry forwards the same key and applies only once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'effect-remote-'));
  dirs.push(dir);
  const store = new EffectStore(join(dir, 'ledger.jsonl'));
  const hooks = createEffectLedgerHooks(store);
  const registry = createHookRegistry();
  registry.register('PreToolUse', hooks.pre);
  let postDone: Promise<unknown> = Promise.resolve();
  registry.register('PostToolUse', (context) => { const result = Promise.resolve(hooks.post(context)); postDone = result; return result; });
  registry.register('PostToolUseFailure', (context) => { const result = Promise.resolve(hooks.post(context)); postDone = result; return result; });
  const keys = new Set<string>();
  let requests = 0;
  let applications = 0;
  const handler = createWebRequestHandler({
    env: {}, domainCheck: () => ({ allowed: true }),
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchFn: async (_url, init) => {
      requests++;
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Caller')).toBe('preserved');
      const key = headers.get('Idempotency-Key');
      expect(key).toBeTruthy();
      expect((await new EffectStore(join(dir, 'ledger.jsonl')).all()).at(-1)?.status).toBe('pending');
      if (!keys.has(key!)) { keys.add(key!); applications++; }
      if (requests === 1) throw new Error('response lost after remote application');
      return new Response('{"id":"order-42"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const dispatcher = new SessionToolDispatcher({
    handlers: new Map([['web_request', handler]]), schemas: [webRequestTool],
    hookRegistry: registry, permissions: { allowedTools: ['web_request'] },
  });
  const call = (id: string) => ({
    id, name: 'web_request', signal: new AbortController().signal,
    input: { method: 'POST', url: 'https://example.test/orders', remote_idempotency: true, headers: { 'X-Caller': 'preserved' } },
  });
  const first = await dispatcher.execute(call('first'));
  expect(first.content).toContain('response lost');
  expect(first.isError).toBe(true);
  await postDone; // post hooks are fire-and-forget; synchronize on the actual hook
  expect(requests).toBe(1);
  expect((await store.all())[0]?.status).toBe('unknown');
  expect((await dispatcher.execute(call('blocked'))).isError).toBe(true);
  expect(requests).toBe(1);
  expect((await dispatcher.execute(call('retry'))).isError).not.toBe(true);
  await postDone;
  expect(requests).toBe(2);
  expect(keys.size).toBe(1);
  expect(applications).toBe(1);
  const original = (await store.all())[0]!;
  const confirmed = await store.reconcile(original.id, async () => ({
    matched: keys.has(original.remoteIdempotencyKey!), evidence: { id: 'order-42' },
  }));
  expect(confirmed.status).toBe('confirmed');
  expect(requests).toBe(2); // reconciliation never invokes the mutating handler
});
