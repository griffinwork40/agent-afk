import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, AcpPermissionOptions, ToolCallStart } from './acp.wire.js';
import type { PermissionResult } from '../../agent/types/sdk-types.js';

const display = vi.hoisted(() => ({
  toolKind: vi.fn((name: string) => (name === 'write_file' ? 'edit' : name === 'bash' ? 'execute' : 'other')),
  toolTitle: vi.fn((name: string, input?: unknown) => {
    const p = (input as Record<string, unknown> | undefined)?.['file_path'];
    return typeof p === 'string' ? `${name} ${p}` : name;
  }),
  toolLocations: vi.fn((_n: string, input: unknown) => {
    const p = (input as Record<string, unknown>)['file_path'];
    return typeof p === 'string' ? [{ path: p }] : [];
  }),
}));
vi.mock('./acp.tool-kind.js', () => display);

import { createAcpPermissionGate } from './acp.permission.js';
import { AcpPeerClosedError } from './acp.rpc-peer.js';
import { createTranslatorState, translateOutputEvent } from './acp.translate.js';
import { permissionOptions, requiresAsk } from './acp.permission.policy.js';

const SID = '11111111-1111-4111-8111-111111111111';
const WRITE_INPUT = { file_path: '/workspace/new.txt', content: 'hello\n' };

interface Ask { params: unknown; signal: AbortSignal | undefined; resolve(v: unknown): void; reject(e: unknown): void }
type LogEntry = { kind: 'emit'; update: ToolCallStart } | { kind: 'request'; method: string; params: unknown };

function fakePeer() {
  const log: LogEntry[] = [];
  const asks: Ask[] = [];
  const peer: AcpClientPeer = {
    request: (method, params, signal) => {
      log.push({ kind: 'request', method, params });
      return new Promise((resolve, reject) => { asks.push({ params, signal, resolve, reject }); });
    },
    notify: () => Promise.resolve(),
  };
  return { peer, log, asks };
}

function setup(over: Partial<AcpPermissionOptions> = {}) {
  const fp = fakePeer();
  const onCancelled = vi.fn();
  const opts: AcpPermissionOptions = {
    skip: false,
    emitToolCall: vi.fn(async (update: ToolCallStart) => { fp.log.push({ kind: 'emit', update }); }),
    onCancelled,
    // Production always supplies the session cwd; without one every path is outside (fail closed).
    cwd: path.resolve('/workspace'),
    ...over,
  };
  const gate = createAcpPermissionGate(fp.peer, SID, opts);
  return { ...fp, gate, opts, onCancelled };
}

function call(gate: ReturnType<typeof setup>['gate'], name: string, input: Record<string, unknown>, id: string, signal = new AbortController().signal): Promise<PermissionResult> {
  return gate.canUseTool(name, input, { signal, toolUseID: id });
}

const selected = (optionId: unknown) => ({ outcome: { outcome: 'selected', optionId } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function untilAsk(asks: Ask[], n = 1): Promise<void> {
  for (let i = 0; i < 50 && asks.length < n; i++) await Promise.resolve();
  expect(asks.length).toBeGreaterThanOrEqual(n);
}
function expectDeny(r: PermissionResult, reason: string): void {
  expect(r).toEqual(expect.objectContaining({ behavior: 'deny', message: `Permission denied: ${reason}` }));
}
function expectAllow(r: PermissionResult): void {
  expect(r).toEqual({ behavior: 'allow' });
}

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => { vi.clearAllMocks(); });

describe('ACP permission policy table', () => {
  it('auto-allows known read/search tools and worktree list only', () => {
    for (const n of ['read_file', 'grep', 'glob', 'list_directory', 'memory_search', 'config_get']) {
      expect(requiresAsk(n, {})).toBe(false);
    }
    // git_read with no subcommand cannot be classified, so it is asked; plain status is not.
    expect(requiresAsk('git_read', {})).toBe(true);
    expect(requiresAsk('git_read', { subcommand: 'status' })).toBe(false);
    expect(requiresAsk('worktree', { action: 'list' })).toBe(false);
    for (const action of ['create', 'remove', 'keep', 'release', undefined]) {
      expect(requiresAsk('worktree', action === undefined ? {} : { action })).toBe(true);
    }
  });
  it('asks for every mutating, network, delegation, MCP, unknown and missing name', () => {
    for (const n of ['bash', 'test_run', 'write_file', 'edit_file', 'patch_apply', 'web_scrape', 'web_request',
      'agent', 'skill', 'compose', 'remote_agent', 'model_complete', 'code_symbols', 'memory_update',
      'config_set', 'send_telegram', 'mcp__srv__read_file', 'exit_plan_mode', 'brand_new_tool', '']) {
      expect(requiresAsk(n, {}), n).toBe(true);
    }
  });
  it('never offers allow_always for bash, and orders options per profile', () => {
    expect(permissionOptions('bash').map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
    expect(permissionOptions('write_file')).toEqual([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow write_file in this session', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ]);
  });
});

describe('ACP permission gate: allow paths', () => {
  it('emits the pending start, awaits it, then sends the exact request (golden shape)', async () => {
    const t = setup();
    let releaseEmit!: () => void;
    (t.opts.emitToolCall as ReturnType<typeof vi.fn>).mockImplementationOnce((update: ToolCallStart) => {
      t.log.push({ kind: 'emit', update });
      return new Promise<void>((r) => { releaseEmit = r; });
    });
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await flush();
    expect(t.asks).toHaveLength(0); // request not sent until the start is emitted
    releaseEmit();
    await untilAsk(t.asks);
    expect(t.log[0]).toEqual({ kind: 'emit', update: {
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'write_file /workspace/new.txt', name: 'write_file',
      kind: 'edit', status: 'pending', rawInput: WRITE_INPUT, content: [], locations: [{ path: '/workspace/new.txt' }],
    } });
    expect(t.log[1]).toEqual({ kind: 'request', method: 'session/request_permission', params: {
      sessionId: SID,
      toolCall: { toolCallId: 'tool-1', title: 'write_file /workspace/new.txt', name: 'write_file', kind: 'edit', status: 'pending', rawInput: WRITE_INPUT },
      options: permissionOptions('write_file'),
    } });
    t.asks[0]!.resolve(selected('allow_once'));
    expectAllow(await p);
    expect(t.log[2]).toEqual({ kind: 'emit', update: expect.objectContaining({ toolCallId: 'tool-1', status: 'in_progress' }) });
  });

  it('never forwards a client input rewrite', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_once' }, updatedInput: { file_path: '/etc/passwd' } });
    const r = await p;
    expectAllow(r);
    expect('updatedInput' in r).toBe(false);
  });

  it('allow_always remembers the exact tool name only', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_always'));
    expectAllow(await p);
    expectAllow(await call(t.gate, 'write_file', { file_path: '/workspace/second.txt' }, 'tool-2'));
    expect(t.asks).toHaveLength(1);
    const other = call(t.gate, 'edit_file', WRITE_INPUT, 'tool-3');
    await untilAsk(t.asks, 2);
    t.asks[1]!.resolve(selected('reject_once'));
    expectDeny(await other, 'rejected');
  });

  it('a remembered grant announces the in_progress transition before allowing', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_always'));
    expectAllow(await p);
    t.log.length = 0;
    expectAllow(await call(t.gate, 'write_file', { file_path: '/workspace/second.txt' }, 'tool-2'));
    expect(t.log).toEqual([{ kind: 'emit', update: expect.objectContaining({
      toolCallId: 'tool-2', name: 'write_file', status: 'in_progress' }) }]);
  });

  it('a remembered grant whose in_progress transition cannot be emitted is denied', async () => {
    let fail = false;
    const t = setup({ emitToolCall: vi.fn(async () => { if (fail) throw new Error('closed'); }) });
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_always'));
    expectAllow(await p);
    fail = true;
    expectDeny(await call(t.gate, 'write_file', WRITE_INPUT, 'tool-2'), 'request_error');
  });

  it('wouldAsk reports consent need from the policy and remembered grants', async () => {
    const t = setup();
    expect(t.gate.wouldAsk?.('read_file', {})).toBe(false);
    expect(t.gate.wouldAsk?.('worktree', { action: 'list' })).toBe(false);
    expect(t.gate.wouldAsk?.('write_file', WRITE_INPUT)).toBe(true);
    expect(t.gate.wouldAsk?.('', {})).toBe(true);
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_always'));
    expectAllow(await p);
    expect(t.gate.wouldAsk?.('write_file', {})).toBe(false);
    expect(t.gate.wouldAsk?.('edit_file', {})).toBe(true);
    expect(createAcpPermissionGate(t.peer, SID, { ...t.opts, skip: true }).wouldAsk?.('bash', {})).toBe(false);
  });

  it('a grant for one tool does not resolve an independent pending ask', async () => {
    const t = setup();
    const a = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    const b = call(t.gate, 'write_file', WRITE_INPUT, 'tool-2');
    await untilAsk(t.asks, 2);
    t.asks[0]!.resolve(selected('allow_always'));
    expectAllow(await a);
    let bDone = false;
    void b.then(() => { bDone = true; });
    await flush();
    expect(bDone).toBe(false); // still pending, independent
    t.asks[1]!.resolve(selected('reject_once'));
    expectDeny(await b, 'rejected');
  });

  it('auto-allowed reads never ask or emit', async () => {
    const t = setup();
    expectAllow(await call(t.gate, 'read_file', { file_path: '/workspace/a' }, 'r1'));
    expect(t.log).toEqual([]);
  });

  it('skip never asks, even for bash', async () => {
    const t = setup({ skip: true });
    expectAllow(await call(t.gate, 'bash', { command: 'rm -rf /' }, 'b1'));
    expect(t.log).toEqual([]);
  });

  it('delegation titles carry the subagent suffix on start and request', async () => {
    const t = setup();
    void call(t.gate, 'agent', { prompt: 'x' }, 'd1');
    await untilAsk(t.asks);
    const suffix = 'agent (each subagent tool call is asked separately)';
    expect((t.log[0] as { update: ToolCallStart }).update.title).toBe(suffix);
    expect((t.asks[0]!.params as { toolCall: { title: string } }).toolCall.title).toBe(suffix);
  });

  it('omits oversize raw input from the start and the request, but still asks', async () => {
    const t = setup();
    void call(t.gate, 'write_file', { file_path: '/workspace/big', content: 'x'.repeat(300 * 1024) }, 'big');
    await untilAsk(t.asks);
    expect('rawInput' in (t.log[0] as { update: ToolCallStart }).update).toBe(false);
    expect('rawInput' in (t.asks[0]!.params as { toolCall: object }).toolCall).toBe(false);
  });

  it('bounds the pending start exactly as the translator bounds a stream start', async () => {
    const t = setup();
    const input = { file_path: '/workspace/mid', content: 'x'.repeat(200 * 1024) };
    void call(t.gate, 'write_file', input, 'mid');
    await untilAsk(t.asks);
    const gateStart = (t.log[0] as { update: ToolCallStart }).update;
    const st = createTranslatorState();
    const [streamStart] = translateOutputEvent({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'mid',
      toolName: 'write_file', toolInput: '', toolInputRaw: JSON.stringify(input) } }, st, { cwd: '/workspace' });
    expect('rawInput' in gateStart).toBe('rawInput' in (streamStart as ToolCallStart));
    const longName = { file_path: `/workspace/${'d'.repeat(5000)}` };
    void call(t.gate, 'write_file', longName, 'long');
    await untilAsk(t.asks, 2);
    expect((t.log[2] as { update: ToolCallStart }).update.title).toBe('Tool call');
  });

  it('resolves relative locations against the session cwd when the gate knows it', async () => {
    const t = setup({ cwd: '/workspace' });
    void call(t.gate, 'write_file', { file_path: 'rel.txt', content: '' }, 'rel');
    await untilAsk(t.asks);
    expect(display.toolLocations).toHaveBeenCalledWith('write_file', expect.anything(), '/workspace');
  });

  it('keeps the delegation suffix even when an oversize title is replaced', async () => {
    const t = setup();
    display.toolTitle.mockReturnValueOnce('agent '.repeat(1000));
    void call(t.gate, 'agent', { prompt: 'p' }, 'a');
    await untilAsk(t.asks);
    expect((t.log[0] as { update: ToolCallStart }).update.title).toBe('Tool call (each subagent tool call is asked separately)');
  });

  it('a throwing display helper still asks with a safe generic start', async () => {
    const t = setup();
    display.toolTitle.mockImplementationOnce(() => { throw new Error('boom'); });
    display.toolKind.mockImplementationOnce(() => { throw new Error('boom'); });
    void call(t.gate, 'mcp__x__y', {}, 'm1');
    await untilAsk(t.asks);
    expect((t.log[0] as { update: ToolCallStart }).update).toEqual(expect.objectContaining({ title: 'mcp__x__y', kind: 'other', status: 'pending' }));
  });
});

describe('ACP permission gate: failure table (section 6)', () => {
  async function answer(reply: unknown, name = 'write_file'): Promise<PermissionResult> {
    const t = setup();
    const p = call(t.gate, name, WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(reply);
    return p;
  }

  it('rejected: reject_once selected', async () => { expectDeny(await answer(selected('reject_once')), 'rejected'); });
  it('unknown_option: unoffered id', async () => { expectDeny(await answer(selected('allow_forever')), 'unknown_option'); });
  it('unknown_option: allow_always for bash was never offered', async () => {
    expectDeny(await answer(selected('allow_always'), 'bash'), 'unknown_option');
  });
  it('unknown_option: option id is matched exactly, kind-like ids are not trusted', async () => {
    expectDeny(await answer(selected('Allow_Once')), 'unknown_option');
  });
  for (const [label, reply] of [
    ['undefined', undefined], ['null', null], ['string', 'allow_once'], ['no outcome', {}],
    ['outcome not object', { outcome: 'selected' }], ['unknown outcome', { outcome: { outcome: 'approved' } }],
    ['selected without id', { outcome: { outcome: 'selected' } }], ['numeric id', selected(1)],
    ['array', [selected('allow_once')]],
  ] as const) {
    it(`malformed_reply: ${label}`, async () => { expectDeny(await answer(reply), 'malformed_reply'); });
  }

  it('request_error: peer request rejects (client error response / write failure)', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.reject(new Error('ACP client error -32603'));
    expectDeny(await p, 'request_error');
  });

  it('request_error: peer request throws synchronously', async () => {
    const t = setup();
    t.peer.request = () => { throw new Error('sync'); };
    expectDeny(await call(t.gate, 'write_file', WRITE_INPUT, 'tool-1'), 'request_error');
  });

  it('peer_closed: closed stdin rejects the pending request', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.reject(new AcpPeerClosedError('eof'));
    expectDeny(await p, 'peer_closed');
  });

  it('request_error: an untyped error that merely reads like a closed peer is not peer_closed', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.reject(new Error('ACP peer closed: eof'));
    expectDeny(await p, 'request_error');
  });

  it('aborted: signal already aborted before the call, nothing is sent', async () => {
    const t = setup();
    const c = new AbortController();
    c.abort();
    expectDeny(await call(t.gate, 'write_file', WRITE_INPUT, 'tool-1', c.signal), 'aborted');
    expect(t.log).toEqual([]);
  });

  it('aborted: signal aborts while awaiting the reply; late allow is ignored', async () => {
    const t = setup();
    const c = new AbortController();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1', c.signal);
    await untilAsk(t.asks);
    c.abort();
    expectDeny(await p, 'aborted');
    expect(t.asks[0]!.signal?.aborted).toBe(true); // outbound request withdrawn
    t.asks[0]!.resolve(selected('allow_always'));
    await flush();
    expect(t.onCancelled).not.toHaveBeenCalled();
  });

  it('aborted: signal is aborted after the reply arrived (recheck before allow)', async () => {
    const t = setup();
    const sig = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1', sig);
    await untilAsk(t.asks);
    (sig as { aborted: boolean }).aborted = true;
    t.asks[0]!.resolve(selected('allow_once'));
    expectDeny(await p, 'aborted');
  });

  it('aborted: signal aborts while the in_progress transition is being emitted', async () => {
    const c = new AbortController();
    const t = setup();
    (t.opts.emitToolCall as ReturnType<typeof vi.fn>).mockImplementation(async (u: ToolCallStart) => {
      if (u.status === 'in_progress') c.abort();
    });
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1', c.signal);
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_once'));
    expectDeny(await p, 'aborted');
  });

  it('cancelled: outcome cancelled denies and signals onCancelled once', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve({ outcome: { outcome: 'cancelled' } });
    const r = await p;
    expectDeny(r, 'cancelled');
    expect(r).toEqual(expect.objectContaining({ interrupt: true }));
    expect(t.onCancelled).toHaveBeenCalledTimes(1);
  });

  it('cancelled: a throwing onCancelled still denies', async () => {
    const t = setup({ onCancelled: () => { throw new Error('boom'); } });
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve({ outcome: { outcome: 'cancelled' } });
    expectDeny(await p, 'cancelled');
  });

  it('timeout: no answer within 120 seconds', async () => {
    vi.useFakeTimers();
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    await vi.advanceTimersByTimeAsync(119_999);
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectDeny(await p, 'timeout');
    expect(t.asks[0]!.signal?.aborted).toBe(true);
    t.asks[0]!.resolve(selected('allow_once'));
  });

  it('request_error: pending start cannot be emitted, no orphaned request', async () => {
    const t = setup({ emitToolCall: () => Promise.reject(new Error('write failed')) });
    expectDeny(await call(t.gate, 'write_file', WRITE_INPUT, 'tool-1'), 'request_error');
    expect(t.log.filter((e) => e.kind === 'request')).toEqual([]);
  });

  it('request_error: emitToolCall throwing synchronously still denies', async () => {
    const t = setup({ emitToolCall: () => { throw new Error('sync'); } });
    expectDeny(await call(t.gate, 'write_file', WRITE_INPUT, 'tool-1'), 'request_error');
    expect(t.asks).toHaveLength(0);
  });

  it('request_error: a failing in_progress transition cannot become an allow', async () => {
    const t = setup();
    (t.opts.emitToolCall as ReturnType<typeof vi.fn>).mockImplementation(async (u: ToolCallStart) => {
      if (u.status === 'in_progress') throw new Error('write failed');
    });
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_once'));
    expectDeny(await p, 'request_error');
  });

  it('request_error: an ask without a correlatable tool id is never sent', async () => {
    const t = setup();
    expectDeny(await call(t.gate, 'write_file', WRITE_INPUT, ''), 'request_error');
    expect(t.log).toEqual([]);
  });
});

describe('ACP permission gate: cancelAll and late replies', () => {
  it('cancelAll denies every pending ask without onCancelled; late allow_always grants nothing', async () => {
    const t = setup();
    const a = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    const b = call(t.gate, 'edit_file', WRITE_INPUT, 'tool-2');
    await untilAsk(t.asks, 2);
    t.gate.cancelAll();
    expectDeny(await a, 'cancelled');
    expectDeny(await b, 'cancelled');
    expect(t.onCancelled).not.toHaveBeenCalled();
    t.asks[0]!.resolve(selected('allow_always'));
    t.asks[1]!.resolve(selected('allow_always'));
    await flush();
    const next = call(t.gate, 'write_file', WRITE_INPUT, 'tool-3');
    await untilAsk(t.asks, 3); // asked again: the late reply did not grant
    t.asks[2]!.resolve(selected('reject_once'));
    expectDeny(await next, 'rejected');
  });

  it('cancelAll during the in_progress transition still denies', async () => {
    const t = setup();
    (t.opts.emitToolCall as ReturnType<typeof vi.fn>).mockImplementation(async (u: ToolCallStart) => {
      if (u.status === 'in_progress') t.gate.cancelAll();
    });
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_once'));
    expectDeny(await p, 'cancelled');
  });

  it('cancelAll keeps remembered grants', async () => {
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('allow_always'));
    expectAllow(await p);
    t.gate.cancelAll();
    expectAllow(await call(t.gate, 'write_file', WRITE_INPUT, 'tool-2'));
  });

  it('never installs a path-approval elicitation handler (D10 replaces path approval)', () => {
    expect(setup().gate.elicitationHandler).toBeUndefined();
  });

  it('a non-object input still resolves to a well-formed decision', async () => {
    const t = setup();
    const p = t.gate.canUseTool('write_file', null as unknown as Record<string, unknown>, { signal: new AbortController().signal, toolUseID: 'x' });
    await untilAsk(t.asks);
    t.asks[0]!.resolve(selected('reject_once'));
    expectDeny(await p, 'rejected');
  });

  it('[S10] endTurn denies every pending ask including top-level ones, with reason no_active_turn', async () => {
    // A top-level ask pending at turn-end is denied defensively.
    const t = setup();
    const p = call(t.gate, 'write_file', WRITE_INPUT, 'tool-1');
    await untilAsk(t.asks);
    await t.gate.endTurn();
    expectDeny(await p, 'no_active_turn');
  });
});
