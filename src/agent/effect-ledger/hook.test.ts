import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEffectLedgerHooks } from './hook.js';
import { EffectStore } from './store.js';
import type { PostToolUseContext, PostToolUseFailureContext, PreToolUseContext } from '../hooks.js';

let dir: string;
let path: string;
let store: EffectStore;
const input = { message: 'hello' };
function pre(args: unknown = input, id = 'first'): PreToolUseContext {
  return { event: 'PreToolUse', toolName: 'send_telegram', input: args, sessionId: 'session', toolUseId: id };
}
function success(args: unknown = input, id = 'first'): PostToolUseContext {
  return { event: 'PostToolUse', toolName: 'send_telegram', input: args, output: 'sent', sessionId: 'session', toolUseId: id };
}
function thrown(error = 'response timed out', args: unknown = input, id = 'first'): PostToolUseFailureContext {
  return { event: 'PostToolUseFailure', toolName: 'send_telegram', input: args, error, sessionId: 'session', toolUseId: id };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'effect-ledger-hook-'));
  path = join(dir, 'ledger.jsonl');
  store = new EffectStore(path);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('write-ahead effect hooks with fake remote', () => {
  it('persists intent before remote dispatch, then updates the SAME record to unknown', async () => {
    const hooks = createEffectLedgerHooks(store);
    let applications = 0;
    const remote = async (id: string): Promise<void> => {
      const decision = await hooks.pre(pre(input, id));
      if (decision.decision === 'block') return;
      const recordsBeforeSend = await new EffectStore(path).all();
      expect(recordsBeforeSend).toHaveLength(1);
      expect(recordsBeforeSend[0]?.status).toBe('pending');
      expect(readFileSync(path, 'utf8')).toContain('"status":"pending"');
      applications++;
      await hooks.post(thrown('response timed out', input, id));
    };
    await remote('first');
    expect(applications).toBe(1);
    const first = (await store.all())[0]!;
    expect(first.status).toBe('unknown');
    expect((await hooks.pre(pre(input, 'second'))).reason).toContain('Verify remote state first');
    expect(applications).toBe(1);
    const retry = await hooks.pre(pre(input, 'third'));
    expect(retry.decision).toBeUndefined();
    expect((await store.all())[1]?.retryOf).toBe(first.id);
    applications++;
    await hooks.post(success(input, 'third'));
    expect(applications).toBe(2);
    expect((await store.all()).map((r) => r.status)).toEqual(['unknown', 'executed']);
    expect((await store.all())[0]?.retryAcknowledgedAt).toBeDefined();
  });

  it('known pre-send refusal is failed and allows immediate retry', async () => {
    const hooks = createEffectLedgerHooks(store);
    await hooks.pre(pre());
    await hooks.post(thrown('Telegram is not configured'));
    expect((await store.all())[0]?.status).toBe('failed');
    expect((await hooks.pre(pre(input, 'next'))).decision).toBeUndefined();
  });

  it('error result without definitive rejection is unknown; 4xx HTTP is failed', async () => {
    const hooks = createEffectLedgerHooks(store);
    const http = { method: 'POST', url: 'https://example.test' };
    await hooks.pre({ ...pre(http), toolName: 'web_request' });
    await hooks.post({ ...success(http), toolName: 'web_request', isError: true, output: 'network error' });
    expect((await store.all())[0]?.status).toBe('unknown');
    const rejected = { method: 'PATCH', url: 'https://example.test' };
    await hooks.pre({ ...pre(rejected, 'other'), toolName: 'web_request' });
    await hooks.post({ ...success(rejected, 'other'), toolName: 'web_request', output: '{"status":422}' });
    expect((await store.all())[1]?.status).toBe('failed');
    const ambiguous = { method: 'PUT', url: 'https://example.test' };
    await hooks.pre({ ...pre(ambiguous, 'ambiguous'), toolName: 'web_request' });
    await hooks.post({ ...success(ambiguous, 'ambiguous'), toolName: 'web_request', output: '{"status":408}' });
    expect((await store.all())[2]?.status).toBe('unknown');
  });

  it('different arguments and separate sessions are independent', async () => {
    const hooks = createEffectLedgerHooks(store);
    await hooks.pre(pre());
    await hooks.post(thrown());
    expect((await hooks.pre(pre({ message: 'different' }, 'other'))).decision).toBeUndefined();
    expect((await hooks.pre({ ...pre(input, 'other-session'), sessionId: 'another' })).decision).toBeUndefined();
  });

  it('recovers pending from a crashed process and links the acknowledged retry', async () => {
    const abandoned = createEffectLedgerHooks(store);
    await abandoned.pre(pre());
    const resumed = createEffectLedgerHooks(new EffectStore(path));
    expect((await resumed.pre(pre(input, 'next'))).reason).toContain('outcome unknown');
    expect((await resumed.pre(pre(input, 'again'))).decision).toBeUndefined();
    const rows = await new EffectStore(path).all();
    expect(rows[0]?.status).toBe('pending');
    expect(rows[1]?.retryOf).toBe(rows[0]?.id);
  });

  it('warns but does not block an intentional repeat after execution', async () => {
    const hooks = createEffectLedgerHooks(store);
    await hooks.pre(pre());
    await hooks.post(success());
    const repeat = await hooks.pre(pre(input, 'again'));
    expect(repeat.decision).toBeUndefined();
    expect(repeat.injectContext).toContain('identical external action');
  });

  it('blocks a concurrent identical admission before either remote request executes', async () => {
    const hooks = createEffectLedgerHooks(store);
    let release!: () => void;
    const readGate = new Promise<void>((resolve) => { release = resolve; });
    const original = store.findByIdempotencyKey.bind(store);
    vi.spyOn(store, 'findByIdempotencyKey').mockImplementation(async (key, session) => {
      await readGate;
      return original(key, session);
    });
    const first = hooks.pre(pre(input, 'one'));
    expect((await hooks.pre(pre(input, 'two'))).decision).toBe('block');
    release();
    expect((await first).decision).toBeUndefined();
    expect(await store.all()).toHaveLength(1);
  });

  it('fails open on read and append errors', async () => {
    const broken = new EffectStore(path);
    vi.spyOn(broken, 'findByIdempotencyKey').mockRejectedValue(new Error('read error'));
    vi.spyOn(broken, 'writePending').mockImplementation(() => { throw new Error('write error'); });
    const hooks = createEffectLedgerHooks(broken);
    expect(await hooks.pre(pre())).toEqual({});
    expect(await hooks.post(success())).toEqual({});
  });

  it('does not write for non-external calls or unserializable args', async () => {
    const hooks = createEffectLedgerHooks(store);
    expect(await hooks.pre({ ...pre(), toolName: 'read_file' })).toEqual({});
    const bad: Record<string, unknown> = {};
    Object.defineProperty(bad, 'message', { enumerable: true, get() { throw new Error('bad getter'); } });
    expect(await hooks.pre(pre(bad))).toEqual({});
    expect(await store.all()).toHaveLength(0);
  });
});
