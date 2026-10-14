/* Coverage preserved from the original post-only ledger hook tests. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEffectLedgerHooks, createEffectLedgerPostHook, createEffectLedgerPreHook } from './hook.js';
import { EffectStore } from './store.js';
import type { PostToolUseContext, PostToolUseFailureContext, PreToolUseContext } from '../hooks.js';

let dir: string;
let store: EffectStore;
const pre = (toolName: string, input: unknown, id: string, sessionId = 's'): PreToolUseContext =>
  ({ event: 'PreToolUse', toolName, input, toolUseId: id, sessionId });
const post = (toolName: string, input: unknown, id: string, sessionId = 's', output: unknown = 'ok'): PostToolUseContext =>
  ({ event: 'PostToolUse', toolName, input, toolUseId: id, sessionId, output });
const failure = (toolName: string, input: unknown, id: string, sessionId = 's'): PostToolUseFailureContext =>
  ({ event: 'PostToolUseFailure', toolName, input, toolUseId: id, sessionId, error: 'response dropped' });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'effect-ledger-coverage-'));
  store = new EffectStore(join(dir, 'ledger.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function execute(hooks: ReturnType<typeof createEffectLedgerHooks>, name: string, args: unknown, id: string, sessionId = 's'): Promise<void> {
  expect((await hooks.pre(pre(name, args, id, sessionId))).decision).not.toBe('block');
  expect(await hooks.post(post(name, args, id, sessionId))).toEqual({});
}

describe('legacy behavior coverage: classification, redaction and dedup', () => {
  it.each(['read_file', 'edit_file', 'bash'])('ignores non-external %s', async (name) => {
    const hooks = createEffectLedgerHooks(store);
    const args = name === 'bash' ? { command: 'ls -la' } : { file_path: '/tmp/x' };
    expect(await hooks.pre(pre(name, args, 'id'))).toEqual({});
    expect(await hooks.post(post(name, args, 'id'))).toEqual({});
    expect(await store.all()).toHaveLength(0);
  });

  it('records send_telegram as executed with session identity and same intent id', async () => {
    const hooks = createEffectLedgerHooks(store);
    const args = { message: 'hello' };
    await hooks.pre(pre('send_telegram', args, 'id'));
    const pending = (await store.all())[0]!;
    await hooks.post(post('send_telegram', args, 'id'));
    expect(await store.all()).toMatchObject([{ id: pending.id, operationType: 'send_telegram', status: 'executed', sessionId: 's' }]);
  });

  it('classifies an error result as unknown unless definitely pre-send rejected', async () => {
    const hooks = createEffectLedgerHooks(store);
    const args = { message: 'hello' };
    await hooks.pre(pre('send_telegram', args, 'id'));
    await hooks.post({ ...post('send_telegram', args, 'id'), output: { isError: true, content: 'response dropped' } });
    expect((await store.all())[0]?.status).toBe('unknown');
    await hooks.pre(pre('send_telegram', { message: 'other' }, 'next'));
    await hooks.post({ ...post('send_telegram', { message: 'other' }, 'next'), isError: true, output: 'Telegram is not configured' });
    expect((await store.all())[1]?.status).toBe('failed');
  });

  it('records bash git push and mcp tool operations', async () => {
    const hooks = createEffectLedgerHooks(store);
    await execute(hooks, 'bash', { command: 'git push origin main' }, 'push');
    await execute(hooks, 'mcp__github__create_pr', { title: 'My PR' }, 'mcp');
    expect((await store.all()).map((r) => r.operationType)).toEqual(['bash_external', 'mcp_write:mcp__github__create_pr']);
  });

  it('redacts tokens from arguments before persistence', async () => {
    const hooks = createEffectLedgerHooks(store);
    await execute(hooks, 'send_telegram', { message: 'token sk-ant-api03-' + 'A'.repeat(30) + ' in message' }, 'id');
    const stored = JSON.stringify((await store.all())[0]?.args);
    expect(stored).not.toContain('sk-ant-api03-');
    expect(stored).toContain('[REDACTED]');
  });

  it('records every intentional identical success, including N>=3, as legacy ambiguous duplicate notes', async () => {
    const hooks = createEffectLedgerHooks(store);
    for (const id of ['one', 'two', 'three']) await execute(hooks, 'send_telegram', { message: 'same' }, id);
    expect((await store.all()).map((r) => r.status)).toEqual(['executed', 'ambiguous', 'ambiguous']);
  });

  it('records a duplicate failure after a success as an ambiguous note', async () => {
    const hooks = createEffectLedgerHooks(store);
    await execute(hooks, 'send_telegram', { message: 'same' }, 'one');
    await hooks.pre(pre('send_telegram', { message: 'same' }, 'two'));
    await hooks.post(failure('send_telegram', { message: 'same' }, 'two'));
    expect((await store.all()).map((r) => r.status)).toEqual(['executed', 'ambiguous']);
  });

  it('different args and sessions produce independent executed records', async () => {
    const hooks = createEffectLedgerHooks(store);
    await execute(hooks, 'send_telegram', { message: 'hello' }, 'one', 'A');
    await execute(hooks, 'send_telegram', { message: 'world' }, 'two', 'A');
    await execute(hooks, 'send_telegram', { message: 'hello' }, 'three', 'B');
    expect((await store.all()).map((r) => r.status)).toEqual(['executed', 'executed', 'executed']);
  });

  it('failed attempts with distinct args are independent; uncertain duplicate blocks once', async () => {
    const hooks = createEffectLedgerHooks(store);
    await hooks.pre(pre('send_telegram', { message: 'hello' }, 'one'));
    await hooks.post(failure('send_telegram', { message: 'hello' }, 'one'));
    expect((await hooks.pre(pre('send_telegram', { message: 'hello' }, 'two'))).decision).toBe('block');
    expect((await store.all()).map((r) => r.status)).toEqual(['unknown']);
    expect((await hooks.pre(pre('send_telegram', { message: 'world' }, 'three'))).decision).toBeUndefined();
    await hooks.post(failure('send_telegram', { message: 'world' }, 'three'));
    expect((await store.all()).map((r) => r.status)).toEqual(['unknown', 'unknown']);
  });

  it('failure path ignores non-external tools and post hook ignores non-post events', async () => {
    const hooks = createEffectLedgerHooks(store);
    expect(await hooks.post(failure('read_file', { file_path: '/tmp/x' }, 'id'))).toEqual({});
    expect(await hooks.post(pre('send_telegram', { message: 'hi' }, 'id'))).toEqual({});
    expect(await hooks.post({ event: 'SessionEnd' })).toEqual({});
    expect(await store.all()).toHaveLength(0);
  });

  it('standalone post-only compatibility hook is non-blocking and records a result', async () => {
    const hook = createEffectLedgerPostHook(store);
    expect(await hook(post('send_telegram', { message: 'hello' }, 'id'))).toEqual({});
    expect((await store.all())[0]?.status).toBe('executed');
  });

  it('legacy pre-hook swallows a throwing input getter and does not set an id', async () => {
    const ids = new Map<string, string>();
    const hook = createEffectLedgerPreHook(ids, store);
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, 'message', { enumerable: true, get() { throw new Error('getter throws'); } });
    expect(await hook(pre('send_telegram', args, 'id'))).toEqual({});
    expect(ids.size).toBe(0);
    expect(await store.all()).toHaveLength(0);
  });
});
