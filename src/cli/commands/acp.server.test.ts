/**
 * Tests for the ACP v1 stdio server (acp.server.ts). Seams owned by other
 * lanes (translate, permission, session-load) and acp.session are mocked;
 * golden transcripts from tests/fixtures/acp drive the protocol scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { readFileSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OutputEvent } from '../../agent/types/session-types.js';
import type { AcpClientPeer, AcpPermissionOptions, SessionUpdate } from './acp.wire.js';

vi.mock('./acp.session.js', () => ({ buildAcpSession: vi.fn(), closeAcpSession: vi.fn() }));
vi.mock('./acp.translate.js', () => ({
  createTranslatorState: vi.fn(() => ({ tools: new Map(), cancelled: false })),
  translateOutputEvent: vi.fn((ev: { __acp?: SessionUpdate[] }) => ev.__acp ?? []),
  finishTurn: vi.fn(() => ({ updates: [], stopReason: 'end_turn' })),
}));
vi.mock('./acp.permission.js', () => ({ createAcpPermissionGate: vi.fn() }));
vi.mock('./acp.session-load.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./acp.session-load.js')>(), loadAcpSession: vi.fn(), replayHistory: vi.fn(),
}));

import { exitAfterServer, runAcpServer, type AcpServerOptions } from './acp.server.js';
import * as acpSession from './acp.session.js';
import * as translate from './acp.translate.js';
import * as permission from './acp.permission.js';
import * as sessionLoad from './acp.session-load.js';
import { substitute } from './__test-utils__/acp-replay.js';
import { isContained } from './acp.permission.paths.js';

const mBuild = vi.mocked(acpSession.buildAcpSession);
const mClose = vi.mocked(acpSession.closeAcpSession);
const mFinish = vi.mocked(translate.finishTurn);
const mGate = vi.mocked(permission.createAcpPermissionGate);
const mLoad = vi.mocked(sessionLoad.loadAcpSession);
const mReplay = vi.mocked(sessionLoad.replayHistory);

const WS = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-ws-')));
mkdirSync(path.join(WS, 'sub'));
const FILE_IN_WS = path.join(WS, 'plain.txt');
writeFileSync(FILE_IN_WS, 'x');
afterAll(() => { rmSync(WS, { recursive: true, force: true }); });

/** Fake AgentSession: scripted stream, interrupt releases a blocked stream. */
let script: () => AsyncIterable<OutputEvent> = async function* () { /* empty */ };
let interrupted: () => void = () => {};
const interruptSpy = vi.fn(async () => { interrupted(); });
function waitInterrupt(): Promise<void> { return new Promise((r) => { interrupted = r; }); }
function fakeHandle(): never {
  return { session: { sendMessageStream: vi.fn(() => script()), interrupt: interruptSpy, abort: vi.fn() } } as never;
}
const ev = (updates: SessionUpdate[]): OutputEvent =>
  ({ type: 'chunk', chunk: { type: 'content', content: '' }, __acp: updates }) as unknown as OutputEvent;

beforeEach(() => {
  vi.clearAllMocks();
  mBuild.mockImplementation(async () => fakeHandle());
  mLoad.mockImplementation(async () => fakeHandle());
  mClose.mockResolvedValue(undefined);
  mFinish.mockImplementation(() => ({ updates: [], stopReason: 'end_turn' }));
  mGate.mockImplementation(() => ({ canUseTool: vi.fn() as never, cancelAll: vi.fn() }));
  script = async function* () { /* empty */ };
});

const FIXTURE_ID = '11111111-1111-4111-8111-111111111111';

interface Harness {
  frames: unknown[];
  logs: string[];
  send(frame: unknown): void;
  sendRaw(raw: string | Buffer): void;
  waitFor(n: number): Promise<unknown[]>;
  end(): Promise<void>;
  rawOutput(): string;
}

function startServer(opts: Partial<AcpServerOptions> = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: unknown[] = [];
  const logs: string[] = [];
  let raw = '';
  let buf = '';
  output.on('data', (c: Buffer) => {
    raw += c.toString('utf-8');
    buf += c.toString('utf-8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buf.slice(0, i)) as unknown);
      buf = buf.slice(i + 1);
    }
  });
  const done = runAcpServer({
    model: 'sonnet', maxTurns: 10, input, output, cancelGraceMs: 20,
    log: (l) => { logs.push(l); }, ...opts,
  });
  return {
    frames,
    logs,
    send: (f) => { input.write(JSON.stringify(f) + '\n'); },
    sendRaw: (r) => { input.write(r); },
    async waitFor(n) {
      const start = Date.now();
      while (frames.length < n) {
        if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${n} frames, got ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 2));
      }
      return frames;
    },
    async end() {
      input.end();
      await done;
      await new Promise((r) => setImmediate(r));
    },
    rawOutput: () => raw,
  };
}

const req = (id: number | string, method: string, params?: unknown): unknown =>
  ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
const note = (method: string, params?: unknown): unknown => ({ jsonrpc: '2.0', method, params });

interface TranscriptLine { direction: 'client_to_agent' | 'agent_to_client'; frame: Record<string, unknown> }

/**
 * Load a golden transcript with the README's substitutions applied to the PARSED
 * values (the e2e helper's `substitute`), never to the JSON text: a Windows
 * workspace path holds backslashes, which are escapes inside JSON source.
 */
function loadTranscript(stem: string, cwd: string): TranscriptLine[] {
  const url = new URL(`../../../tests/fixtures/acp/transcripts/${stem}.ndjson`, import.meta.url);
  return readFileSync(url, 'utf-8').split('\n').filter((l) => l.trim())
    .map((l) => substitute(JSON.parse(l), cwd, FIXTURE_ID) as TranscriptLine);
}

vi.mock('node:crypto', async (orig) => ({ ...(await orig<typeof import('node:crypto')>()), randomUUID: () => '11111111-1111-4111-8111-111111111111' }));

type Frame = Record<string, unknown>;
interface Plan { before: SessionUpdate[]; after: SessionUpdate[]; cancel: boolean; perm?: { pending: SessionUpdate; params: unknown } }

/** Split a transcript's agent frames per prompt into stream vs gate-originated parts. */
function plansFor(lines: TranscriptLine[]): Plan[] {
  const plans: Plan[] = [];
  let cur: Plan | undefined;
  let seenPerm = false;
  for (const { direction, frame } of lines) {
    if (direction === 'client_to_agent') {
      if (frame['method'] === 'session/prompt') { cur = { before: [], after: [], cancel: false }; plans.push(cur); seenPerm = false; }
      if (frame['method'] === 'session/cancel' && cur) cur.cancel = true;
      continue;
    }
    if (!cur) continue;
    if ('id' in frame && !('method' in frame)) { cur = undefined; continue; }
    if (frame['method'] === 'session/request_permission') {
      const pending = cur.before.pop()!;
      cur.perm = { pending, params: frame['params'] };
      seenPerm = true;
      continue;
    }
    const update = (frame['params'] as { update: SessionUpdate }).update;
    const isGateProgress = seenPerm && update.sessionUpdate === 'tool_call_update'
      && update.status === 'in_progress' && Object.keys(update).length === 3;
    if (isGateProgress) continue;
    (seenPerm ? cur.after : cur.before).push(update);
  }
  return plans;
}

/** Minimal A3 stand-in honouring the frozen seam: emit pending, ask, emit in_progress on allow. */
function installFakeGate(plans: Plan[]): void {
  mGate.mockImplementation((peer: AcpClientPeer, _sid: string, opts: AcpPermissionOptions) => {
    const ac = new AbortController();
    const canUseTool = async (): Promise<{ behavior: 'allow' | 'deny' }> => {
      const perm = plans[0]!.perm!;
      await opts.emitToolCall(perm.pending as never);
      let reply: unknown;
      try { reply = await peer.request('session/request_permission', perm.params, ac.signal); } catch { return { behavior: 'deny' }; }
      const outcome = (reply as { outcome: { outcome: string; optionId?: string } }).outcome;
      if (outcome.outcome === 'cancelled') { opts.onCancelled(); return { behavior: 'deny' }; }
      if (outcome.optionId?.startsWith('allow')) {
        await opts.emitToolCall({ ...(perm.pending as object), status: 'in_progress' } as never);
        return { behavior: 'allow' };
      }
      return { behavior: 'deny' };
    };
    return { canUseTool: canUseTool as never, cancelAll: () => ac.abort() };
  });
}

function installScript(plans: Plan[]): void {
  script = async function* () {
    const plan = plans[0]!;
    const interruptedP = waitInterrupt();
    for (const u of plan.before) yield ev([u]);
    if (plan.perm) {
      const opts = mBuild.mock.calls.at(-1)?.[0] ?? mLoad.mock.calls.at(-1)?.[1];
      await opts!.canUseTool!('t', {}, { signal: new AbortController().signal } as never);
    }
    if (plan.cancel) await interruptedP;
    for (const u of plan.after) yield ev([u]);
    plans.shift();
  };
}

async function replay(stem: string): Promise<void> {
  const lines = loadTranscript(stem, WS);
  const plans = plansFor(lines);
  installFakeGate(plans);
  installScript(plans);
  mReplay.mockImplementation(async (sessionId, peer) => {
    const start = lines.findIndex((l) => l.frame['method'] === 'session/load');
    for (const l of lines.slice(start + 1)) {
      if (l.frame['method'] !== 'session/update') break;
      await peer.notify('session/update', { ...(l.frame['params'] as object), sessionId });
    }
  });
  const h = startServer();
  let expected = 0;
  for (const l of lines) {
    if (l.direction === 'agent_to_client') { expected++; continue; }
    await h.waitFor(expected);
    h.send(l.frame);
  }
  await h.waitFor(expected);
  await new Promise((r) => setTimeout(r, 30));
  expect(h.frames).toEqual(lines.filter((l) => l.direction === 'agent_to_client').map((l) => l.frame));
  await h.end();
}

describe('ACP server — golden transcripts', () => {
  for (const stem of [
    'text-turn', 'tool-read', 'tool-edit-diff', 'tool-bash-failed', 'permission-allow-once', 'permission-reject',
    'permission-allow-always-then-skip', 'cancel-during-permission', 'cancel-during-stream', 'load-replay', 'resume',
    'close-idempotent', 'bad-version-negotiation',
  ]) {
    it(`replays ${stem}`, async () => { await replay(stem); });
  }
});

const init = req(1, 'initialize', { protocolVersion: 1 });
type Res = { id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };
async function run(frames: unknown[], opts: Partial<AcpServerOptions> = {}): Promise<{ out: Res[]; h: Harness }> {
  const h = startServer(opts);
  for (const f of frames) h.send(f);
  await h.end();
  return { out: h.frames as Res[], h };
}
/** One frame per request, each sent only after the previous reply: no handler races. */
async function seq(frames: unknown[], opts: Partial<AcpServerOptions> = {}): Promise<{ out: Res[]; h: Harness }> {
  const h = startServer(opts);
  for (const [i, f] of frames.entries()) { h.send(f); await h.waitFor(i + 1); }
  await h.end();
  return { out: h.frames as Res[], h };
}
const newSession = (id = 2, params: Record<string, unknown> = {}): unknown =>
  req(id, 'session/new', { cwd: WS, mcpServers: [], ...params });

describe('ACP server — initialize', () => {
  it('negotiates version 1 and rejects a string version as invalid params', async () => {
    const { out } = await run([req(1, 'initialize', { protocolVersion: '1.0' }), req(2, 'initialize', { protocolVersion: 7 })]);
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } });
    expect(out[1]!.result!['protocolVersion']).toBe(1);
  });
  it('rejects duplicate initialize and session methods before initialize', async () => {
    const { out } = await run([newSession(1), init, req(3, 'initialize', { protocolVersion: 1 })]);
    expect(out.map((r) => r.error?.code ?? 'ok')).toEqual([-32600, 'ok', -32600]);
  });
  it('unknown and unadvertised methods are method not found', async () => {
    const { out } = await run([init, req(2, 'session/list', {}), req(3, 'session/set_mode', {})]);
    expect(out.slice(1).map((r) => r.error)).toEqual([
      { code: -32601, message: 'Method not found' }, { code: -32601, message: 'Method not found' }]);
  });
});

describe('ACP server — session/new', () => {
  it('hands the gate canUseTool, cwd, id and converted MCP config to buildAcpSession', async () => {
    const canUseTool = vi.fn();
    mGate.mockImplementation(() => ({ canUseTool: canUseTool as never, cancelAll: vi.fn() }));
    const mcp = [{ name: 'fs', command: '/bin/fs', args: ['-x'], env: [{ name: 'K', value: 'v' }] }];
    const { out } = await run([init, newSession(2, { cwd: path.join(WS, 'sub'), mcpServers: mcp })]);
    expect(out[1]!.result).toEqual({ sessionId: FIXTURE_ID });
    expect(mGate).toHaveBeenCalledWith(expect.anything(), FIXTURE_ID, expect.objectContaining({ skip: false }));
    expect(mBuild).toHaveBeenCalledWith(expect.objectContaining({
      canUseTool, cwd: path.join(WS, 'sub'), sessionId: FIXTURE_ID,
      mcpServers: { fs: { type: 'stdio', command: '/bin/fs', args: ['-x'], env: { K: 'v' } } },
    }));
  });
  it('skips the gate entirely with --dangerously-skip-permissions', async () => {
    await run([init, newSession()], { dangerouslySkipPermissions: true });
    expect(mGate).not.toHaveBeenCalled();
    expect(mBuild.mock.calls[0]![0].canUseTool).toBeUndefined();
    expect(mBuild.mock.calls[0]![0].dangerouslySkipPermissions).toBe(true);
    expect(mBuild.mock.calls[0]![0].childCanUseTool).toBeUndefined();
  });
  it('hands the gate child factory to buildAcpSession as childCanUseTool (D9)', async () => {
    const forChild = vi.fn();
    mGate.mockImplementation(() => ({ canUseTool: vi.fn() as never, cancelAll: vi.fn(), forChild: forChild as never }));
    await run([init, newSession()]);
    expect(mBuild.mock.calls[0]![0].childCanUseTool).toBe(forChild);
  });
  it('D14: accepts an existing cwd outside the server launch directory, canonicalised', async () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'acp-elsewhere-'));
    try {
      // Precondition: outside the launch directory, including on another drive
      // (Windows CI: checkout on D:, temp on C:, where path.relative is absolute).
      expect(isContained(process.cwd(), realpathSync.native(elsewhere))).toBe(false);
      const { out } = await run([init, newSession(2, { cwd: elsewhere })]);
      expect(out[1]!.result).toEqual({ sessionId: FIXTURE_ID });
      expect(mBuild).toHaveBeenCalledWith(expect.objectContaining({ cwd: realpathSync.native(elsewhere) }));
      expect(mGate).toHaveBeenCalledWith(expect.anything(), FIXTURE_ID, expect.objectContaining({ cwd: realpathSync.native(elsewhere) }));
    } finally { rmSync(elsewhere, { recursive: true, force: true }); }
  });
  it.each([
    ['cwd that is a file', { cwd: FILE_IN_WS }],
    ['missing cwd', { cwd: path.join(WS, 'nope') }],
    ['relative cwd', { cwd: 'sub' }],
    ['http mcp', { mcpServers: [{ type: 'http', name: 'h', url: 'https://x', headers: [] }] }],
    ['duplicate mcp name', { mcpServers: [{ name: 'a', command: '/a', args: [], env: [] }, { name: 'a', command: '/b', args: [], env: [] }] }],
    ['duplicate env name', { mcpServers: [{ name: 'a', command: '/a', args: [], env: [{ name: 'K', value: '1' }, { name: 'K', value: '2' }] }] }],
    ['relative mcp command', { mcpServers: [{ name: 'a', command: 'a', args: [], env: [] }] }],
    ['additional directories', { additionalDirectories: [WS] }],
    ['missing mcpServers', { mcpServers: undefined }],
  ])('rejects %s as invalid params without leaking details', async (_n, params) => {
    const { out } = await run([init, newSession(2, params)]);
    expect(out[1]!.error).toEqual({ code: -32602, message: 'Invalid params' });
    expect(mBuild).not.toHaveBeenCalled();
  });
  it('session construction failure is a generic internal error', async () => {
    mBuild.mockRejectedValueOnce(new Error('ANTHROPIC_API_KEY missing at /secret/path'));
    const { out, h } = await run([init, newSession()]);
    expect(out[1]!.error).toEqual({ code: -32603, message: 'Internal error' });
    expect(h.rawOutput()).not.toMatch(/secret|ANTHROPIC/);
    expect(h.logs.join('\n')).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('ACP server — session/prompt', () => {
  it('rejects bad prompts: unknown session, image media, string prompt', async () => {
    const { out } = await run([init, newSession(),
      req(3, 'session/prompt', { sessionId: 'nope', prompt: [] }),
      req(4, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }),
      req(5, 'session/prompt', { sessionId: FIXTURE_ID, prompt: 'hello' })]);
    // Match replies by request id, not arrival order. `session/new` checks the
    // directory on disk, so the unknown-session rejection for request 3 can
    // overtake its reply; JSON-RPC allows that. All five must still arrive.
    const codeFor = (id: number): number | undefined => out.find((r) => r.id === id)?.error?.code;
    expect(out).toHaveLength(5);
    expect(out.find((r) => r.id === 2)?.result).toEqual({ sessionId: FIXTURE_ID });
    expect([3, 4, 5].map(codeFor)).toEqual([-32002, -32602, -32602]);
  });
  it('normalizes content blocks in order joined by newlines', async () => {
    const { h } = await run([init, newSession(), req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [
      { type: 'text', text: 'a' }, { type: 'resource_link', name: 'n', uri: 'file:///x' },
      { type: 'resource', resource: { uri: 'file:///y', text: 'body' } },
      { type: 'resource', resource: { uri: 'file:///z', blob: 'AAAA' } }] })]);
    expect(h.frames.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    const session = (await mBuild.mock.results[0]!.value) as { session: { sendMessageStream: ReturnType<typeof vi.fn> } };
    expect(session.session.sendMessageStream).toHaveBeenCalledWith('a\nn (file:///x)\nfile:///y\nbody\nfile:///z (binary resource omitted)');
  });
  it('a second prompt during an active turn is invalid request', async () => {
    script = async function* () { await waitInterrupt(); };
    const h = startServer();
    h.send(init); h.send(newSession());
    await h.waitFor(2);
    h.send(req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    h.send(req(4, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await h.waitFor(3);
    expect(h.frames[2]).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32600, message: 'Invalid request' } });
    await h.end();
    expect(h.frames[3]).toEqual({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
  });
  it('a provider error is a generic internal error, removes the dead session', async () => {
    script = async function* () { yield { type: 'error', error: new Error('sk-ant-secret 401') } as OutputEvent; };
    const { out, h } = await run([init, newSession(),
      req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }),
    ]);
    expect(out[2]).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error' } });
    expect(h.rawOutput()).not.toMatch(/sk-ant/);
    expect(mClose).toHaveBeenCalledTimes(1);
  });
  it('a dead session is not reused after an error', async () => {
    script = async function* () { yield { type: 'error', error: new Error('boom') } as OutputEvent; };
    const h = startServer();
    h.send(init); h.send(newSession());
    h.send(req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await h.waitFor(3);
    h.send(req(4, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await h.waitFor(4);
    expect((h.frames[3] as Res).error?.code).toBe(-32002);
    await h.end();
  });
  it('maps finishTurn stop reasons', async () => {
    mFinish.mockImplementation(() => ({ updates: [], stopReason: 'max_tokens' }));
    const { out } = await run([init, newSession(), req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] })]);
    expect(out[2]!.result).toEqual({ stopReason: 'max_tokens' });
  });
  it('wires onCancelled so a permission-originated cancel ends the turn cancelled', async () => {
    let onCancelled!: () => void;
    mGate.mockImplementation((_p, _s, o) => { onCancelled = o.onCancelled; return { canUseTool: vi.fn() as never, cancelAll: vi.fn() }; });
    script = async function* () { await waitInterrupt(); };
    const h = startServer();
    h.send(init); h.send(newSession());
    await h.waitFor(2);
    h.send(req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await new Promise((r) => setTimeout(r, 10));
    onCancelled();
    await h.waitFor(3);
    expect(h.frames[2]).toEqual({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
    expect(interruptSpy).toHaveBeenCalled();
    await h.end();
  });
});

describe('ACP server — cancel and close', () => {
  it('cancel of an idle or unknown session, or malformed, sends nothing', async () => {
    const { out, h } = await run([init, newSession(), note('session/cancel', { sessionId: FIXTURE_ID }),
      note('session/cancel', { sessionId: 'nope' }), note('session/cancel', {})]);
    expect(out).toHaveLength(2);
    expect(h.logs.join('\n')).toMatch(/malformed session\/cancel/);
  });
  it('close during a turn resolves the prompt cancelled before replying {}', async () => {
    script = async function* () { await waitInterrupt(); };
    const h = startServer();
    h.send(init); h.send(newSession());
    await h.waitFor(2);
    h.send(req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await new Promise((r) => setTimeout(r, 10));
    h.send(req(4, 'session/close', { sessionId: FIXTURE_ID }));
    await h.waitFor(4);
    expect(h.frames.slice(2)).toEqual([
      { jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } }, { jsonrpc: '2.0', id: 4, result: {} }]);
    expect(mClose).toHaveBeenCalledTimes(1);
    await h.end();
  });
  it('EOF cancels active turns, rejects pending peer requests and releases sessions', async () => {
    let rejected = false;
    mGate.mockImplementation((peer) => ({
      canUseTool: vi.fn() as never, cancelAll: vi.fn(),
      __ask: peer.request('session/request_permission', {}).catch(() => { rejected = true; }),
    }) as never);
    script = async function* () { await waitInterrupt(); };
    const h = startServer();
    h.send(init); h.send(newSession());
    await h.waitFor(3);
    h.send(req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await new Promise((r) => setTimeout(r, 10));
    await h.end();
    expect(rejected).toBe(true);
    expect(h.frames.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
    expect(mClose).toHaveBeenCalledTimes(1);
  });
});

describe('ACP server — shutdown bound (D17)', () => {
  it('EOF closes sessions concurrently; a hung close is abandoned at the deadline', async () => {
    let n = 0;
    mBuild.mockImplementation(async () => ({ ...(fakeHandle() as object), tag: ++n }) as never);
    mLoad.mockImplementation(async () => ({ ...(fakeHandle() as object), tag: ++n }) as never);
    const closed: number[] = [];
    mClose.mockImplementation(async (handle) => {
      const tag = (handle as unknown as { tag?: number }).tag;
      if (tag === 1) await new Promise(() => { /* a close that never finishes */ });
      closed.push(tag ?? 0);
    });
    const h = startServer({ shutdownDeadlineMs: 50 });
    h.send(init); h.send(newSession(2));
    h.send(req(3, 'session/resume', { sessionId: 'other-session', cwd: WS }));
    await h.waitFor(3);
    const started = Date.now();
    await h.end();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(closed).toEqual([2]);
    expect(mClose).toHaveBeenCalledTimes(2);
    expect(h.logs.join('\n')).toMatch(/session close still running after 50ms/);
  });
  it('exitAfterServer flushes output then exits with the process exit code', async () => {
    const output = new PassThrough();
    const exit = vi.fn();
    await exitAfterServer(output, exit);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it('SIGINT routes into the bounded teardown: sessions are released and handlers are removed', async () => {
    script = async function* () { await waitInterrupt(); };
    const h = startServer({ shutdownDeadlineMs: 200 });
    h.send(init); h.send(newSession());
    await h.waitFor(2);
    h.send(req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await new Promise((r) => setTimeout(r, 10));
    // Emit SIGINT — should trigger the same bounded teardown as EOF.
    process.emit('SIGINT', 'SIGINT');
    // runAcpServer should resolve (not hang) and close the session.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for server to shut down after SIGINT')), 1_000);
      h.end().then(() => { clearTimeout(t); resolve(); }, reject);
    });
    expect(mClose).toHaveBeenCalledTimes(1);
    expect(h.logs.join('\n')).toMatch(/signal received/);
    // Listener must be removed after teardown — a second emit must not trigger another destroy.
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
  it('SIGTERM routes into the bounded teardown and removes its listener', async () => {
    const h = startServer({ shutdownDeadlineMs: 200 });
    h.send(init); h.send(newSession());
    await h.waitFor(2);
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for server to shut down after SIGTERM')), 1_000);
      h.end().then(() => { clearTimeout(t); resolve(); }, reject);
    });
    expect(mClose).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('ACP server — load and resume', () => {
  it('unknown id is resource not found; failed replay releases the session', async () => {
    // The real load module's not-found signal (a class, no numeric code), not an invented coded error.
    mLoad.mockRejectedValueOnce(new sessionLoad.AcpNotFoundError('Unknown session'));
    mReplay.mockRejectedValueOnce(new Error('corrupt journal /x'));
    const params = { sessionId: FIXTURE_ID, cwd: WS, mcpServers: [] };
    const h = startServer();
    const steps = [init, req(2, 'session/load', params), req(3, 'session/load', params),
      req(4, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] })];
    for (const [i, f] of steps.entries()) { h.send(f); await h.waitFor(i + 1); }
    await h.end();
    const out = h.frames as Res[];
    expect(out.slice(1).map((r) => r.error?.code)).toEqual([-32002, -32603, -32002]);
    expect(h.rawOutput()).not.toMatch(/corrupt|journal/);
    expect(mClose).toHaveBeenCalledTimes(1);
  });
  it('load replays with the restored canonical cwd so relative tool locations resolve', async () => {
    await run([init, req(2, 'session/load', { sessionId: FIXTURE_ID, cwd: path.join(WS, 'sub'), mcpServers: [] })]);
    expect(mReplay).toHaveBeenCalledWith(FIXTURE_ID, expect.anything(), path.join(WS, 'sub'));
  });
  it('D15: resume of a live idle id succeeds on the same handle; resume omits replay and defaults mcpServers to []', async () => {
    const { out } = await seq([init, req(2, 'session/resume', { sessionId: FIXTURE_ID, cwd: WS }),
      req(3, 'session/resume', { sessionId: FIXTURE_ID, cwd: WS }),
      req(4, 'session/resume', { sessionId: FIXTURE_ID, cwd: WS, mcpServers: [] })]);
    expect(out.slice(1).map((r) => r.result)).toEqual([{}, {}, {}]);
    expect(mReplay).not.toHaveBeenCalled();
    expect(mLoad).toHaveBeenCalledTimes(1);
    expect(mLoad).toHaveBeenCalledWith({ sessionId: FIXTURE_ID, cwd: WS, mcpServers: [] }, expect.objectContaining({ mcpServers: {} }));
    expect(mClose).toHaveBeenCalledTimes(1);
  });
  it('D15: load of a live idle id (from session/new) replays again and keeps the live handle and gate', async () => {
    const { out } = await seq([init, newSession(),
      req(3, 'session/load', { sessionId: FIXTURE_ID, cwd: WS, mcpServers: [] }),
      req(4, 'session/load', { sessionId: FIXTURE_ID, cwd: WS, mcpServers: [] }),
      req(5, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [{ type: 'text', text: 'hi' }] })]);
    expect(out.slice(2)).toEqual([
      { jsonrpc: '2.0', id: 3, result: {} }, { jsonrpc: '2.0', id: 4, result: {} },
      { jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } }]);
    expect(mReplay).toHaveBeenCalledTimes(2);
    expect(mReplay).toHaveBeenCalledWith(FIXTURE_ID, expect.anything(), WS);
    expect(mLoad).not.toHaveBeenCalled();
    expect(mBuild).toHaveBeenCalledTimes(1);
    expect(mGate).toHaveBeenCalledTimes(1);
  });
  it('D15: load or resume while a prompt is in flight is invalid request and does not disturb the turn', async () => {
    script = async function* () { await waitInterrupt(); };
    const h = startServer();
    h.send(init); h.send(newSession());
    await h.waitFor(2);
    h.send(req(3, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }));
    await new Promise((r) => setTimeout(r, 10));
    h.send(req(4, 'session/load', { sessionId: FIXTURE_ID, cwd: WS, mcpServers: [] }));
    h.send(req(5, 'session/resume', { sessionId: FIXTURE_ID, cwd: WS }));
    await h.waitFor(4);
    expect(h.frames.slice(2)).toEqual([
      { jsonrpc: '2.0', id: 4, error: { code: -32600, message: 'Invalid request' } },
      { jsonrpc: '2.0', id: 5, error: { code: -32600, message: 'Invalid request' } }]);
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(mReplay).not.toHaveBeenCalled();
    await h.end();
    expect(h.frames.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
  });
  it('D15: reopening a live session with another cwd or MCP list is invalid params, session kept', async () => {
    const mcp = [{ name: 'a', command: '/a', args: [], env: [] }];
    const { out } = await seq([init, newSession(),
      req(3, 'session/load', { sessionId: FIXTURE_ID, cwd: path.join(WS, 'sub'), mcpServers: [] }),
      req(4, 'session/resume', { sessionId: FIXTURE_ID, cwd: WS, mcpServers: mcp }),
      req(5, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] })]);
    expect(out.slice(2).map((r) => r.error?.code ?? r.result)).toEqual([-32602, -32602, { stopReason: 'end_turn' }]);
    expect(mReplay).not.toHaveBeenCalled();
    // Released once, by EOF only: the rejected reopen did not close it.
    expect(mClose).toHaveBeenCalledTimes(1);
  });
  it('D16: session errors carry data.sessionId; other errors carry no data', async () => {
    mLoad.mockRejectedValueOnce(new sessionLoad.AcpNotFoundError('Unknown session'));
    mLoad.mockRejectedValueOnce(new sessionLoad.AcpNotFoundError('Unknown session'));
    const { out } = await seq([init, newSession(),
      req(3, 'session/prompt', { sessionId: 'tck-never', prompt: [] }),
      req(4, 'session/load', { sessionId: 'gone-1', cwd: WS, mcpServers: [] }),
      req(5, 'session/resume', { sessionId: 'gone-2', cwd: WS }),
      req(6, 'session/close', { sessionId: FIXTURE_ID }),
      req(7, 'session/prompt', { sessionId: FIXTURE_ID, prompt: [] }),
      req(8, 'session/prompt', { sessionId: FIXTURE_ID, prompt: 'not an array' }),
      req(9, 'session/new', { cwd: 'relative', mcpServers: [] })]);
    const nf = (id: number, sessionId: string) =>
      ({ jsonrpc: '2.0', id, error: { code: -32002, message: 'Resource not found', data: { sessionId } } });
    expect(out.slice(2)).toEqual([nf(3, 'tck-never'), nf(4, 'gone-1'), nf(5, 'gone-2'),
      { jsonrpc: '2.0', id: 6, result: {} }, nf(7, FIXTURE_ID),
      { jsonrpc: '2.0', id: 8, error: { code: -32602, message: 'Invalid params' } },
      { jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'Invalid params' } }]);
  });
});

describe('ACP server — transport safety', () => {
  it('parse error, invalid envelope and oversize lines use null ids; blank lines are skipped', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { pad: 'x'.repeat(1_048_577) } });
    const h = startServer();
    h.sendRaw('\n  \nnot json\n');
    h.sendRaw(Buffer.from([0xff, 0xfe, 0x0a]));
    h.send({ jsonrpc: '2.0', id: 1 });
    h.send({ jsonrpc: '1.0', id: 2, method: 'initialize' });
    h.sendRaw(big + '\n');
    h.send(init);
    await h.end();
    expect(h.frames).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid request' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'Invalid request' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
      expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: 1 }) }),
    ]);
  });
  it('stdout carries protocol frames only; unknown response ids are ignored and logged', async () => {
    const { h } = await run([init, { jsonrpc: '2.0', id: 'acp:42', result: {} }]);
    for (const line of h.rawOutput().trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0');
    expect(h.frames).toHaveLength(1);
    expect(h.logs.join('\n')).toMatch(/acp:42/);
  });
});
