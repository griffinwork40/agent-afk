/**
 * Tests for POST /api/sessions/:id/commands route handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/** Untyped call-through mock; the precise signature is irrelevant to these tests. */
type AnyMock = Mock<(...args: unknown[]) => unknown>;
import type { ServerResponse } from 'node:http';

// --- mocks ---

let mockEnsureSlashRegistry: AnyMock;
let mockParse: AnyMock;
let mockLookup: AnyMock;
let mockSuggest: AnyMock;
let mockIsGated: AnyMock;
let mockGateReason: AnyMock;
let mockGetStats: AnyMock;
let mockBuildSessionRef: AnyMock;
let mockBuildOptionalSessionRef: AnyMock;
let mockCreateWebSlashContext: AnyMock;

vi.mock('./slash-registry.js', () => ({
  ensureSlashRegistry: (...args: unknown[]) => mockEnsureSlashRegistry(...args),
}));
vi.mock('../cli/slash/registry.js', () => ({
  parse: (...args: unknown[]) => mockParse(...args),
  lookup: (...args: unknown[]) => mockLookup(...args),
  suggest: (...args: unknown[]) => mockSuggest(...args),
}));
vi.mock('./command-gate.js', () => ({
  isGated: (...args: unknown[]) => mockIsGated(...args),
  gateReason: (...args: unknown[]) => mockGateReason(...args),
}));
vi.mock('./session-owner.slash.js', () => ({
  getStats: (...args: unknown[]) => mockGetStats(...args),
  buildSessionRef: (...args: unknown[]) => mockBuildSessionRef(...args),
  buildOptionalSessionRef: (...args: unknown[]) => mockBuildOptionalSessionRef(...args),
}));
vi.mock('./slash-context.web.js', () => ({
  createWebSlashContext: (...args: unknown[]) => mockCreateWebSlashContext(...args),
}));
import type { BufferingWriter } from './writer.buffer.js';
import type { Writer } from '../cli/slash/types.js';

import { handleCommand, normalizeSlashResult } from './routes.commands.js';
import { ChoiceBroker } from './choice-broker.js';

// --- helpers ---

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(s: number) { status = s; },
    end(payload: string) { chunks.push(payload); },
  } as unknown as ServerResponse;
  return { res, json: () => ({ status, body: JSON.parse(chunks.join('')) as unknown }) };
}

const SESSION_ID = 'test-session-abc123';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    owned: new Set([SESSION_ID]),
    bridge: {} as never,
    submitPrompt: vi.fn(),
    isBusy: vi.fn().mockReturnValue(false),
    reserveTurn: vi.fn(),
    releaseTurn: vi.fn(),
    getSessionCwd: vi.fn().mockReturnValue('/tmp'),
    getSession: vi.fn().mockReturnValue({ sessionId: SESSION_ID }),
    ...overrides,
  };
}

const FAKE_CMD = {
  name: '/help',
  acceptsAttachments: false,
  handler: vi.fn().mockResolvedValue('continue'),
};

const FAKE_STATS = { totalTurns: 0, model: 'sonnet' } as never;
const FAKE_REF = { current: {} } as never;
const FAKE_CTX = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureSlashRegistry = vi.fn().mockResolvedValue(undefined);
  mockParse = vi.fn().mockReturnValue({ name: '/help', args: '' });
  mockLookup = vi.fn().mockReturnValue(FAKE_CMD);
  mockSuggest = vi.fn().mockReturnValue(undefined);
  mockIsGated = vi.fn().mockReturnValue(false);
  mockGateReason = vi.fn().mockReturnValue(undefined);
  mockGetStats = vi.fn().mockReturnValue(FAKE_STATS);
  mockBuildSessionRef = vi.fn().mockReturnValue(FAKE_REF);
  mockBuildOptionalSessionRef = vi.fn().mockReturnValue(FAKE_REF);
  mockCreateWebSlashContext = vi.fn().mockReturnValue(FAKE_CTX);
  FAKE_CMD.handler = vi.fn().mockResolvedValue('continue');
});

describe('handleCommand', () => {
  it('400 for invalid session id', async () => {
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, '../bad', { input: '/help' });
    expect(json().status).toBe(400);
    expect((json().body as { error: string }).error).toBe('bad_session_id');
  });

  it('409 for unowned session', async () => {
    const ctx = makeCtx({ owned: new Set() });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(409);
    expect((json().body as { error: string }).error).toBe('session_not_owned');
  });

  it('501 when turn accounting (reserveTurn/releaseTurn) is absent', async () => {
    // Contract: commands route requires isBusy+reserveTurn+releaseTurn to
    // guarantee turn serialization. Missing any → 501 commands_not_supported.
    const ctx = makeCtx({ reserveTurn: undefined, releaseTurn: undefined });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(501);
    expect((json().body as { error: string }).error).toBe('commands_not_supported');
  });

  it('501 when only releaseTurn is absent', async () => {
    const ctx = makeCtx({ releaseTurn: undefined });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(501);
  });

  it('400 for missing input field', async () => {
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, {});
    expect(json().status).toBe(400);
    expect((json().body as { error: string }).error).toBe('bad_request');
  });

  it('409 for busy session', async () => {
    const ctx = makeCtx({ isBusy: vi.fn().mockReturnValue(true) });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(409);
    expect((json().body as { error: string }).error).toBe('session_busy');
  });

  it('busy check does not call reserveTurn', async () => {
    const ctx = makeCtx({ isBusy: vi.fn().mockReturnValue(true) });
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(ctx.reserveTurn).not.toHaveBeenCalled();
    expect(ctx.releaseTurn).not.toHaveBeenCalled();
  });

  it('404 for unknown command with no suggestion', async () => {
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue(undefined);
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/unknown' });
    expect(json().status).toBe(404);
    expect((json().body as { error: string }).error).toBe('unknown_command');
    expect((json().body as { suggestion?: string }).suggestion).toBeUndefined();
  });

  it('404 for unknown command includes suggestion', async () => {
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue('/help');
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/hlep' });
    expect(json().status).toBe(404);
    expect((json().body as { suggestion: string }).suggestion).toBe('/help');
  });

  it('409 for gated command with reason', async () => {
    mockIsGated.mockReturnValue(true);
    mockGateReason.mockReturnValue('requires terminal readline');
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/clear' });
    expect(json().status).toBe(409);
    expect((json().body as { error: string }).error).toBe('command_gated');
    expect((json().body as { reason: string }).reason).toBe('requires terminal readline');
  });

  it('503 when stats not initialized', async () => {
    mockGetStats.mockReturnValue(undefined);
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(503);
  });

  it('503 when getSession is wired but returns undefined (session not ready)', async () => {
    // getSession present but returns undefined → session not available yet
    const ctx = makeCtx({ getSession: vi.fn().mockReturnValue(undefined) });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(503);
    expect((json().body as { error: string }).error).toBe('session_not_ready');
  });

  it('500 when handler throws', async () => {
    FAKE_CMD.handler = vi.fn().mockRejectedValue(new Error('boom'));
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(500);
    expect((json().body as { error: string }).error).toBe('command_execution_failed');
  });

  it('504 with command_timeout error shape when handler exceeds timeout', async () => {
    vi.useFakeTimers();
    // Handler never resolves — simulates a runaway command.
    FAKE_CMD.handler = vi.fn().mockReturnValue(new Promise<never>(() => {}));
    const ctx = makeCtx();
    const { res, json } = makeRes();
    const promise = handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    // Advance past the 15 s handler timeout.
    await vi.advanceTimersByTimeAsync(15_001);
    await promise;
    expect(json().status).toBe(504);
    const body = json().body as { error: string; message: string };
    expect(body.error).toBe('command_timeout');
    expect(typeof body.message).toBe('string');
    // releaseTurn must still fire (finally block).
    expect(ctx.releaseTurn).toHaveBeenCalledWith(SESSION_ID);
    vi.useRealTimers();
  });

  it('always calls releaseTurn even when handler throws', async () => {
    FAKE_CMD.handler = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx = makeCtx();
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(ctx.releaseTurn).toHaveBeenCalledWith(SESSION_ID);
  });

  it('always calls releaseTurn on gated command', async () => {
    mockIsGated.mockReturnValue(true);
    mockGateReason.mockReturnValue('reason');
    const ctx = makeCtx();
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/clear' });
    expect(ctx.releaseTurn).toHaveBeenCalledWith(SESSION_ID);
  });

  it('happy path returns 200 with blocks and control', async () => {
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(200);
    const body = json().body as { blocks: unknown[]; control: { kind: string } };
    expect(body.blocks).toEqual([]);
    expect(body.control.kind).toBe('continue');
  });

  it('serializes ordered structured output via the real buffer writer', async () => {
    mockCreateWebSlashContext.mockImplementation((_ref, _stats, writer) => ({
      out: (writer as BufferingWriter).asWriterInterface(),
    }));
    FAKE_CMD.handler = vi.fn().mockImplementation(async ({ out }: { out: Writer }) => {
      out.raw('before');
      out.line(' line');
      out.block!({ kind: 'table', columns: ['Name'], rows: [['AFK']], text: 'Name\nAFK\n', ansi: 'Name\nAFK\n' });
      out.raw('after');
      return 'continue';
    });
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json()).toEqual({ status: 200, body: { blocks: [
      { kind: 'text', text: 'before line\n', ansi: 'before line\n' },
      { kind: 'table', columns: ['Name'], rows: [['AFK']], text: 'Name\nAFK\n', ansi: 'Name\nAFK\n' },
      { kind: 'text', text: 'after', ansi: 'after' },
    ], control: { kind: 'continue' } } });
  });

  it('preserves structured output order together with owner metadata and clear control', async () => {
    mockCreateWebSlashContext.mockImplementation((_ref, _stats, writer) => ({
      out: (writer as BufferingWriter).asWriterInterface(),
    }));
    const executeSessionControl = vi.fn(async (_id, _cmd, { out }: { out: Writer }) => {
      out.raw('before');
      out.block!({ kind: 'keyValue', entries: [{ key: 'State', value: 'cleared' }], text: 'State: cleared\n', ansi: 'State: cleared\n' });
      out.raw('after');
      return { result: 'continue' as const, control: { kind: 'clear' as const }, session: { model: 'sonnet', name: 'Merged session', thinkingUi: 'off' as const } };
    });
    const ctx = makeCtx({ executeSessionControl });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/clear' });
    expect(json()).toEqual({ status: 200, body: {
      blocks: [
        { kind: 'text', text: 'before', ansi: 'before' },
        { kind: 'keyValue', entries: [{ key: 'State', value: 'cleared' }], text: 'State: cleared\n', ansi: 'State: cleared\n' },
        { kind: 'text', text: 'after', ansi: 'after' },
      ],
      control: { kind: 'clear' },
      session: { model: 'sonnet', name: 'Merged session', thinkingUi: 'off' },
    } });
    expect(FAKE_CMD.handler).not.toHaveBeenCalled();
    expect(ctx.reserveTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(ctx.releaseTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
  });

  it.each(['/clear', '/model', '/name', '/thinking', '/fast', '/compact'])('routes %s through owner adapter with exactly one reservation', async (name) => {
    const cmd = { ...FAKE_CMD, name };
    mockLookup.mockReturnValue(cmd);
    mockParse.mockReturnValue({ name, args: 'value' });
    const executeSessionControl = vi.fn().mockResolvedValue({
      result: 'continue',
      ...(name === '/clear' ? { control: { kind: 'clear' } } : {}),
      ...(name === '/model' ? { session: { model: 'opus' } } : {}),
    });
    const ctx = makeCtx({ executeSessionControl });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: `${name} value` });
    expect(json().status).toBe(200);
    expect(executeSessionControl).toHaveBeenCalledWith(SESSION_ID, cmd, FAKE_CTX, 'value');
    expect(cmd.handler).not.toHaveBeenCalled();
    expect(ctx.reserveTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(ctx.releaseTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(json().body).toMatchObject({ control: { kind: name === '/clear' ? 'clear' : 'continue' } });
    if (name === '/model') expect(json().body).toMatchObject({ session: { model: 'opus' } });
  });

  it('failed clear never emits a clear control and releases once', async () => {
    const ctx = makeCtx({ executeSessionControl: vi.fn().mockRejectedValue(new Error('reset failed')) });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/clear' });
    expect(json()).toMatchObject({ status: 500, body: { error: 'command_execution_failed' } });
    expect(json().body).not.toHaveProperty('control');
    expect(ctx.releaseTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
  });

  it('blocks a concurrent command while owner control is awaiting provider', async () => {
    let finish!: (result: { result: 'continue' }) => void;
    let busy = false;
    const executeSessionControl = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const ctx = makeCtx({
      isBusy: vi.fn(() => busy),
      reserveTurn: vi.fn(() => { busy = true; }),
      releaseTurn: vi.fn(() => { busy = false; }),
      executeSessionControl,
    });
    const first = makeRes();
    const pending = handleCommand(ctx, first.res, SESSION_ID, { input: '/compact' });
    await vi.waitFor(() => expect(executeSessionControl).toHaveBeenCalledOnce());
    const second = makeRes();
    await handleCommand(ctx, second.res, SESSION_ID, { input: '/clear' });
    expect(second.json().status).toBe(409);
    finish({ result: 'continue' });
    await pending;
    expect(ctx.reserveTurn).toHaveBeenCalledOnce();
    expect(ctx.releaseTurn).toHaveBeenCalledOnce();
  });

  it('happy path: reserveTurn called before handler, releaseTurn after', async () => {
    const order: string[] = [];
    const ctx = makeCtx({
      reserveTurn: vi.fn().mockImplementation(() => { order.push('reserve'); }),
      releaseTurn: vi.fn().mockImplementation(() => { order.push('release'); }),
    });
    FAKE_CMD.handler = vi.fn().mockImplementation(async () => { order.push('handler'); return 'continue'; });
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(order).toEqual(['reserve', 'handler', 'release']);
  });

  it('wires choose/progress to the broker and command result remains serialized', async () => {
    const choiceBroker = new ChoiceBroker();
    const notices = vi.fn();
    choiceBroker.subscribe(SESSION_ID, notices);
    mockCreateWebSlashContext.mockReturnValue({ out: {} });
    FAKE_CMD.handler = vi.fn().mockImplementation(async (context: {
      choose: (request: { corrId: string; title: string; options: { value: string; label: string }[] }) => Promise<string | null>;
      progress: (event: { corrId: string; phase: 'end'; label: string }) => void;
    }) => {
      const selection = await context.choose({ corrId: 'prompt-1', title: 'Choose', options: [{ value: 'yes', label: 'Yes' }] });
      context.progress({ corrId: 'prompt-1', phase: 'end', label: selection ?? 'cancelled' });
      return 'continue';
    });
    const result = makeRes();
    const pending = handleCommand(makeCtx({ choiceBroker }), result.res, SESSION_ID, { input: '/help' });
    await vi.waitFor(() => expect(notices).toHaveBeenCalledWith({ type: 'choice_request', request: expect.objectContaining({ corrId: 'prompt-1' }) }));
    expect(choiceBroker.answer(SESSION_ID, 'prompt-1', 'yes')).toBe('answered');
    await pending;
    expect(result.json().status).toBe(200);
    expect(notices).toHaveBeenCalledWith({ type: 'progress', corrId: 'prompt-1', phase: 'end', label: 'yes' });
  });

  it('aborting the HTTP command response cancels pending choice and releases the turn', async () => {
    const { EventEmitter } = await import('node:events');
    const choiceBroker = new ChoiceBroker();
    mockCreateWebSlashContext.mockReturnValue({ out: {} });
    FAKE_CMD.handler = vi.fn().mockImplementation((context: { choose: (request: unknown) => Promise<string | null> }) =>
      context.choose({ corrId: 'disconnect', title: 'Choose', options: [{ value: 'yes', label: 'Yes' }] }).then(() => 'continue'));
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() {},
      end() { this.writableEnded = true; },
    }) as unknown as ServerResponse;
    const ctx = makeCtx({ choiceBroker });
    const pending = handleCommand(ctx, response, SESSION_ID, { input: '/help' });
    await vi.waitFor(() => expect(choiceBroker.answer('other', 'disconnect', 'yes')).toBe('wrong_session'));
    response.emit('close');
    await pending;
    expect(choiceBroker.answer(SESSION_ID, 'disconnect', 'yes')).toBe('unknown');
    expect(ctx.releaseTurn).toHaveBeenCalledOnce();
  });
});

// --- Auth test: POST to /commands without valid Origin/cookie must be rejected
// This is enforced at the server dispatch layer (server.ts bearer+Origin checks),
// not inside handleCommand itself. The server.test.ts integration tests cover the
// full auth flow. Here we confirm the handler itself does NOT enforce auth —
// auth is a server-level concern, consistent with how handlePrompt is tested.
describe('handleCommand — security: 500 response body is redacted', () => {
  it('500 body does not echo the raw error message', async () => {
    FAKE_CMD.handler = vi.fn().mockRejectedValue(new Error('secret internal detail'));
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(500);
    const body = json().body as { error: string; message: string };
    expect(body.error).toBe('command_execution_failed');
    // Raw err.message must NOT appear in the response body.
    expect(body.message).not.toContain('secret internal detail');
    expect(body.message).toBe('An internal error occurred while executing the command.');
  });

  it('404 message truncates command name to 64 chars', async () => {
    const longName = '/'.padEnd(70, 'a'); // 70-char name
    mockParse.mockReturnValue({ name: longName, args: '' });
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue(undefined);
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: longName });
    expect(json().status).toBe(404);
    const body = json().body as { message: string };
    // Truncated name is at most 64 chars.
    const nameInMsg = body.message.replace('unknown command: ', '');
    expect(nameInMsg.length).toBeLessThanOrEqual(64);
  });

  it('504 when handler exceeds 15s timeout', async () => {
    vi.useFakeTimers();
    FAKE_CMD.handler = vi.fn().mockImplementation(
      () => new Promise<never>(() => { /* never resolves */ }),
    );
    const { res, json } = makeRes();
    const pending = handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    await vi.runAllTimersAsync();
    await pending;
    expect(json().status).toBe(504);
    expect((json().body as { error: string }).error).toBe('command_timeout');
    vi.useRealTimers();
  });

  it('504 releases the turn reservation', async () => {
    vi.useFakeTimers();
    FAKE_CMD.handler = vi.fn().mockImplementation(
      () => new Promise<never>(() => { /* never resolves */ }),
    );
    const ctx = makeCtx();
    const { res } = makeRes();
    const pending = handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    await vi.runAllTimersAsync();
    await pending;
    expect(ctx.releaseTurn).toHaveBeenCalledWith(SESSION_ID);
    vi.useRealTimers();
  });
});

describe('handleCommand — no server-level auth enforcement in unit tests', () => {
  it('handler itself does not check Origin (server dispatch layer does)', async () => {
    // handleCommand trusts that server.ts already enforced Origin+bearer.
    // If it reaches handleCommand, it proceeds normally.
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(200);
  });
});

describe('normalizeSlashResult — all 6 SlashResult variants', () => {
  it("'continue' → { kind: 'continue' }", () => {
    expect(normalizeSlashResult('continue')).toEqual({ kind: 'continue' });
  });
  it("'exit' → { kind: 'exit' }", () => {
    expect(normalizeSlashResult('exit')).toEqual({ kind: 'exit' });
  });
  it("'forward' → { kind: 'forward' }", () => {
    expect(normalizeSlashResult('forward')).toEqual({ kind: 'forward' });
  });
  it('{ rerun } → { kind: rerun, input }', () => {
    expect(normalizeSlashResult({ rerun: 'my cmd' })).toEqual({ kind: 'rerun', input: 'my cmd' });
  });
  it('{ kind: submit } → { kind: submit, message }', () => {
    expect(normalizeSlashResult({ kind: 'submit', message: 'hello' })).toEqual({ kind: 'submit', message: 'hello' });
  });
  it('{ kind: prefill } → { kind: prefill, message }', () => {
    expect(normalizeSlashResult({ kind: 'prefill', message: 'world' })).toEqual({ kind: 'prefill', message: 'world' });
  });
});
