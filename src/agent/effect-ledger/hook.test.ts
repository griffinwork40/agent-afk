/**
 * Integration tests for the PostToolUse effect-ledger hook.
 *
 * Each test creates an isolated EffectStore backed by a temp file to avoid
 * cross-test contamination.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEffectLedgerPostHook } from './hook.js';
import { EffectStore } from './store.js';
import type { PostToolUseContext } from '../hooks.js';

let tmpDir: string;
let ledgerPath: string;
let store: EffectStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'effect-ledger-hook-test-'));
  ledgerPath = join(tmpDir, 'effect-ledger.jsonl');
  store = new EffectStore(ledgerPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<PostToolUseContext> = {}): PostToolUseContext {
  return {
    event: 'PostToolUse',
    toolName: 'send_telegram',
    input: { message: 'hello' },
    output: { content: 'Sent Telegram message to chat 12345.' },
    sessionId: 'test-session',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Non-external tools are ignored
// ---------------------------------------------------------------------------

describe('createEffectLedgerPostHook — non-external tools', () => {
  it('does not write a record for read_file', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName: 'read_file',
      input: { file_path: '/tmp/foo.ts' },
      output: { content: 'file contents' },
    };
    await hook(ctx);
    const all = await store.all();
    expect(all).toHaveLength(0);
  });

  it('does not write a record for edit_file', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName: 'edit_file',
      input: {},
      output: {},
    };
    await hook(ctx);
    expect(await store.all()).toHaveLength(0);
  });

  it('does not write a record for bash ls', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName: 'bash',
      input: { command: 'ls -la' },
      output: { content: 'file list' },
    };
    await hook(ctx);
    expect(await store.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// External tools are recorded
// ---------------------------------------------------------------------------

describe('createEffectLedgerPostHook — external tools', () => {
  it('records send_telegram as executed', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeCtx());
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.operationType).toBe('send_telegram');
    expect(all[0]?.status).toBe('executed');
    expect(all[0]?.sessionId).toBe('test-session');
  });

  it('records send_telegram as failed when output has isError: true', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeCtx({ output: { isError: true, content: 'Telegram is not configured' } }));
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('failed');
  });

  it('records bash git push as external', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName: 'bash',
      input: { command: 'git push origin main' },
      output: { content: 'Branch pushed.' },
      sessionId: 'sess-2',
    };
    await hook(ctx);
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.operationType).toBe('bash_external');
    expect(all[0]?.status).toBe('executed');
  });

  it('records mcp__ tool as mcp_write', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName: 'mcp__github__create_pr',
      input: { title: 'My PR', body: 'desc' },
      output: { number: 42 },
    };
    await hook(ctx);
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.operationType).toBe('mcp_write');
  });

  it('stores redacted args (token removed)', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName: 'send_telegram',
      input: { message: 'token sk-ant-api03-' + 'A'.repeat(30) + ' in message' },
      output: { content: 'Sent.' },
    };
    await hook(ctx);
    const all = await store.all();
    expect(all).toHaveLength(1);
    const argsStr = JSON.stringify(all[0]?.args);
    expect(argsStr).not.toContain('sk-ant-api03-');
    expect(argsStr).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Idempotency — dedup for executed records
// ---------------------------------------------------------------------------

describe('createEffectLedgerPostHook — dedup behavior', () => {
  it('records both calls when same args sent twice (marks first ambiguous on second)', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx = makeCtx();
    // First call: records as executed.
    await hook(ctx);
    // Second call with same args: prior record exists with status "executed".
    // The hook writes a new pending record (the "ambiguous" note).
    await hook(ctx);

    const all = await store.all();
    // After id-collapse, we have 2 distinct records (2 distinct ids).
    // One is executed; one is pending (the ambiguous note).
    expect(all.length).toBeGreaterThanOrEqual(2);
    const statuses = all.map((r) => r.status);
    expect(statuses).toContain('executed');
    expect(statuses).toContain('pending');
  });

  it('second call with different args creates a new independent record', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeCtx({ input: { message: 'hello' } }));
    await hook(makeCtx({ input: { message: 'world' } }));

    const all = await store.all();
    expect(all.length).toBe(2);
    const statuses = all.map((r) => r.status);
    expect(statuses.every((s) => s === 'executed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-PostToolUse events are ignored
// ---------------------------------------------------------------------------

describe('createEffectLedgerPostHook — non-matching events', () => {
  it('ignores PreToolUse events', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx = { event: 'PreToolUse' as const, toolName: 'send_telegram', input: { message: 'hi' } };
    await hook(ctx);
    expect(await store.all()).toHaveLength(0);
  });

  it('ignores SessionEnd events', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx = { event: 'SessionEnd' as const };
    await hook(ctx);
    expect(await store.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Return value is always an empty HookDecision (non-blocking)
// ---------------------------------------------------------------------------

describe('createEffectLedgerPostHook — return value', () => {
  it('returns an empty decision (never blocks)', async () => {
    const hook = createEffectLedgerPostHook(store);
    const decision = await hook(makeCtx());
    expect(decision).toEqual({});
    expect((decision as Record<string, unknown>)['decision']).toBeUndefined();
  });
});
