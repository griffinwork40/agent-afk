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
import { createEffectLedgerPostHook, createEffectLedgerPreHook } from './hook.js';
import { EffectStore } from './store.js';
import type { PostToolUseContext, PostToolUseFailureContext, PreToolUseContext } from '../hooks.js';

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
    expect(all[0]?.operationType).toBe('mcp_write:mcp__github__create_pr');
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
    // One is executed; one is ambiguous (the dedup note).
    expect(all.length).toBeGreaterThanOrEqual(2);
    const statuses = all.map((r) => r.status);
    expect(statuses).toContain('executed');
    expect(statuses).toContain('ambiguous');
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

  it('third identical call is still caught as ambiguous (N>=3)', async () => {
    const hook = createEffectLedgerPostHook(store);
    const ctx = makeCtx();
    await hook(ctx); // executed
    await hook(ctx); // ambiguous
    await hook(ctx); // must also be ambiguous, not executed

    const all = await store.all();
    expect(all).toHaveLength(3);
    const statuses = all.map((r) => r.status);
    expect(statuses.filter((s) => s === 'executed')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'ambiguous')).toHaveLength(2);
  });

  it('two sessions sending the same message are independent (no cross-session dedup)', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeCtx({ sessionId: 'session-A' }));
    await hook(makeCtx({ sessionId: 'session-B' }));

    const all = await store.all();
    expect(all).toHaveLength(2);
    // Both should be 'executed' -- no false dedup across sessions.
    expect(all.every((r) => r.status === 'executed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PostToolUseFailure dedup behavior
// ---------------------------------------------------------------------------

describe('createEffectLedgerPostHook — PostToolUseFailure dedup', () => {
  function makeFailureCtx(overrides: Partial<PostToolUseFailureContext> = {}): PostToolUseFailureContext {
    return {
      event: 'PostToolUseFailure',
      toolName: 'send_telegram',
      input: { message: 'hello' },
      error: 'Telegram send failed',
      sessionId: 'test-session',
      ...overrides,
    };
  }

  it('records first failure as failed', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeFailureCtx());
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('failed');
  });

  it('marks duplicate failure (same args) as ambiguous', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeFailureCtx());
    await hook(makeFailureCtx());

    const all = await store.all();
    expect(all).toHaveLength(2);
    const statuses = all.map((r) => r.status);
    expect(statuses).toContain('failed');
    expect(statuses).toContain('ambiguous');
  });

  it('marks failure after prior executed record as ambiguous', async () => {
    const hook = createEffectLedgerPostHook(store);
    // First call succeeds via PostToolUse.
    await hook(makeCtx());
    // Second call fails via PostToolUseFailure with the same args.
    await hook(makeFailureCtx());

    const all = await store.all();
    expect(all).toHaveLength(2);
    const statuses = all.map((r) => r.status);
    expect(statuses).toContain('executed');
    expect(statuses).toContain('ambiguous');
  });

  it('records failure with different args as independent failed record', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeFailureCtx({ input: { message: 'hello' } }));
    await hook(makeFailureCtx({ input: { message: 'world' } }));

    const all = await store.all();
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.status === 'failed')).toBe(true);
  });

  it('ignores non-external tools on failure path', async () => {
    const hook = createEffectLedgerPostHook(store);
    await hook(makeFailureCtx({ toolName: 'read_file', input: { file_path: '/tmp/foo' } }));
    expect(await store.all()).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// PreToolUse hook — computeIdempotencyKey throw guard (#1475)
// ---------------------------------------------------------------------------

describe('createEffectLedgerPreHook — computeIdempotencyKey throw guard', () => {
  it('returns {} instead of throwing when input causes computeIdempotencyKey to throw', () => {
    const pendingIds = new Map<string, string>();
    const hook = createEffectLedgerPreHook(pendingIds, store);

    // An object with a getter that throws causes stableStringify (used inside
    // computeIdempotencyKey) to throw. The hook must swallow the error and
    // return {} to satisfy its non-blocking contract.
    const throwingInput: Record<string, unknown> = {};
    Object.defineProperty(throwingInput, 'message', {
      get() { throw new Error('getter throws'); },
      enumerable: true,
    });

    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'send_telegram',
      input: throwingInput,
      toolUseId: 'tool-use-1',
    };

    expect(() => hook(ctx)).not.toThrow();
    const decision = hook(ctx);
    expect(decision).toEqual({});
    // No pending record should have been written for the failing input.
    expect(pendingIds.size).toBe(0);
  });
});
