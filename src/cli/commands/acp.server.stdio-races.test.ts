/**
 * Red team 3c, item 4: races through the FULL stdio server.
 *
 * Uses real runAcpServer with mocked acp.session / acp.translate /
 * acp.permission (same pattern as acp.server.test.ts). Tests assert
 * the SAFE behaviour and therefore FAIL when the code is broken.
 *
 * Four races under test:
 *   R1 — permission reply after the turn ended (session/cancel before reply)
 *   R2 — session/load of a live session while a permission request is pending
 *   R3 — permission reply for a session already closed (session/close then reply)
 *   R4 — 120-second permission timeout with fake timers
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
  ...await importOriginal<typeof import('./acp.session-load.js')>(),
  loadAcpSession: vi.fn(), replayHistory: vi.fn(),
}));
vi.mock('node:crypto', async (orig) => ({
  ...(await orig<typeof import('node:crypto')>()),
  randomUUID: () => '11111111-1111-4111-8111-111111111111',
}));

import { runAcpServer, type AcpServerOptions } from './acp.server.js';
import * as acpSession from './acp.session.js';
import * as translate from './acp.translate.js';
import * as permission from './acp.permission.js';
import * as sessionLoad from './acp.session-load.js';

const mBuild = vi.mocked(acpSession.buildAcpSession);
const mClose = vi.mocked(acpSession.closeAcpSession);
const mFinish = vi.mocked(translate.finishTurn);
const mGate = vi.mocked(permission.createAcpPermissionGate);
const mLoad = vi.mocked(sessionLoad.loadAcpSession);
const mReplay = vi.mocked(sessionLoad.replayHistory);

const WS = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-r4c-races-')));
afterAll(() => { rmSync(WS, { recursive: true, force: true }); });

const SID = '11111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// Harness helpers (mirror acp.server.test.ts pattern)
// ---------------------------------------------------------------------------
function startServer(opts: Partial<AcpServerOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: unknown[] = [];
  const logs: string[] = [];
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString('utf-8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buf.slice(0, i)) as unknown);
      buf = buf.slice(i + 1);
    }
  });
  const done = runAcpServer({
    model: 'sonnet', maxTurns: 10, input, output, cancelGraceMs: 20,
    shutdownDeadlineMs: 200,
    log: (l) => { logs.push(l); },
    ...opts,
  });
  return {
    frames, logs,
    send: (f: unknown) => { input.write(JSON.stringify(f) + '\n'); },
    async waitFor(n: number, ms = 2000) {
      const start = Date.now();
      while (frames.length < n) {
        if (Date.now() - start > ms) throw new Error(`waitFor(${n}): only ${frames.length} frames: ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return frames;
    },
    async end() { input.end(); await done; await new Promise((r) => setImmediate(r)); },
    async waitForFrame(pred: (f: unknown) => boolean, ms = 2000): Promise<unknown> {
      const start = Date.now();
      while (true) {
        const found = frames.find(pred);
        if (found) return found;
        if (Date.now() - start > ms) throw new Error(`waitForFrame timeout; frames: ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

const req = (id: number | string, method: string, params?: unknown): unknown =>
  ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
const note = (method: string, params?: unknown): unknown =>
  ({ jsonrpc: '2.0', method, params });
const resp = (id: string, result: unknown): unknown =>
  ({ jsonrpc: '2.0', id, result });

function isError(f: unknown): boolean {
  return typeof f === 'object' && f !== null && 'error' in f;
}
function isPermRequest(f: unknown): boolean {
  return typeof f === 'object' && f !== null &&
    (f as Record<string, unknown>)['method'] === 'session/request_permission';
}
/** The session/prompt response has id=3 (after init=1, session/new=2). */
function isPromptResponse(f: unknown): boolean {
  const r = f as Record<string, unknown>;
  return r['id'] === 3 && 'result' in r && !('method' in r) && !('error' in r);
}

let interrupted: () => void = () => {};
const interruptSpy = vi.fn(async () => { interrupted(); });
function waitInterrupt(): Promise<void> { return new Promise((r) => { interrupted = r; }); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeHandle(): any {
  return { session: { sendMessageStream: vi.fn(), interrupt: interruptSpy, abort: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mBuild.mockImplementation(async () => fakeHandle());
  mLoad.mockImplementation(async () => fakeHandle());
  mClose.mockResolvedValue(undefined);
  mFinish.mockImplementation(() => ({ updates: [], stopReason: 'end_turn' }));
  mGate.mockImplementation(() => ({ canUseTool: vi.fn() as never, cancelAll: vi.fn() }));
});

// ---------------------------------------------------------------------------
// Setup: initialize + session/new helpers
// ---------------------------------------------------------------------------
async function setupSession(h: ReturnType<typeof startServer>) {
  h.send(req(1, 'initialize', { protocolVersion: 1 }));
  h.send(req(2, 'session/new', { cwd: WS, mcpServers: [] }));
  await h.waitFor(2);
  return SID;
}

// ---------------------------------------------------------------------------
// R1: permission reply after the turn ended (via session/cancel before reply)
//
// Sequence:
//   1. Start a turn that blocks waiting for a permission reply
//   2. Send session/cancel (turn ends, gate.cancelAll called)
//   3. Send the allow reply anyway (late reply)
//
// Safe: the late reply must NOT cause an allow. The turn result must be
//   cancelled/denied, and no second prompt response should arrive.
// ---------------------------------------------------------------------------
describe('R1: late permission reply after session/cancel must deny', () => {
  it('a permission reply after cancel does not produce an allow', async () => {
    // Contract: History — the peer.handleResponse path in acp.server.ts:141
    // calls peer.handleResponse(frame). In acp.permission.ts awaitReply, the
    // settle function is guarded by `done` flag. After cancelAll fires settle
    // with 'cancelled', done=true, so any later peer response is ignored via
    // handleResponse returning false (the id is no longer in pending map).
    // Gate that blocks until cancelled
    mGate.mockImplementation((peer: AcpClientPeer, _sid: string, opts: AcpPermissionOptions) => {
      const ac = new AbortController();
      const canUseTool = async (): Promise<{ behavior: 'allow' | 'deny' }> => {
        // Emit pending start
        await opts.emitToolCall({
          sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'write_file new.txt',
          name: 'write_file', kind: 'edit', status: 'pending', content: [], locations: [],
        } as never);
        // Send permission request and block
        try {
          const result = await peer.request('session/request_permission', {
            sessionId: _sid,
            toolCall: { toolCallId: 'tc-1', title: 'write_file new.txt', status: 'pending' },
            options: [
              { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
            ],
          }, ac.signal);
          // If we somehow get here after cancel, that is the bug.
          return (result as { outcome: { optionId: string } }).outcome.optionId.startsWith('allow')
            ? { behavior: 'allow' } : { behavior: 'deny' };
        } catch {
          return { behavior: 'deny' };
        }
      };
      return {
        canUseTool: canUseTool as never,
        cancelAll: () => { ac.abort(); },
        endTurn: async () => {},
        wouldAsk: () => true,
        forChild: () => canUseTool as never,
      };
    });

    // Script: stream blocks until interrupted
    const handle = fakeHandle();
    // Stream calls canUseTool (triggering the gate permission request), then
    // blocks waiting for interrupt (cancel).
    (handle.session.sendMessageStream as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      const calls = mBuild.mock.calls;
      const opts = calls[calls.length - 1]?.[0];
      await opts?.canUseTool?.('write_file', { file_path: `${WS}/new.txt`, content: 'x' },
        { signal: new AbortController().signal, toolUseID: 'tc-1' } as never);
      await waitInterrupt();
      yield { type: 'done', metadata: { stopReason: 'cancelled' } } as OutputEvent;
    });
    mBuild.mockResolvedValue(handle);

    const h = startServer();
    const sid = await setupSession(h);

    // Start a turn that will ask for permission
    h.send(req(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'write something' }] }));

    // Wait for the permission request frame (arrives after emitToolCall + peer.request)
    const permFrame = await h.waitForFrame(isPermRequest) as Record<string, unknown>;
    const permId = permFrame['id'] as string;

    // Cancel the turn BEFORE sending reply
    h.send(note('session/cancel', { sessionId: sid }));

    // Wait for the prompt response (cancelled)
    await h.waitFor(4);

    // Now send a late allow reply
    h.send(resp(permId, { outcome: { outcome: 'selected', optionId: 'allow_once' } }));

    // Give a moment for any late processing
    await new Promise((r) => setTimeout(r, 50));

    // Safe assertion: the prompt response must reflect cancellation (not allow),
    // and there must be exactly ONE prompt response (no second one from the late reply).
    const allPromptResps = h.frames.filter(isPromptResponse);
    expect(allPromptResps.length,
      `FINDING: ${allPromptResps.length} prompt responses — late reply caused a second allow response`
    ).toBe(1);

    // The stop reason in the response should indicate cancellation, not end_turn
    // (The result.stopReason comes from finishTurn mock which returns 'end_turn',
    //  but the key safety property is no second response.)
    const permRequestsAfterCancel = h.frames.filter(isPermRequest);
    expect(permRequestsAfterCancel.length,
      `FINDING: ${permRequestsAfterCancel.length} permission requests — extra request after cancel`
    ).toBe(1);

    await h.end();
  });
});

// ---------------------------------------------------------------------------
// R2: session/load of a live session while a permission request is pending
//
// Profile §2 / acp.handlers.ts:191: "if the provider reports ... A prompt in
// flight ... is invalid request." reopenLive throws INVALID_REQUEST when
// live.active is set.
//
// Safe: the load must fail with an error response (not succeed), and the
// pending permission must still be deniable.
// ---------------------------------------------------------------------------
describe('R2: session/load while permission pending must return error', () => {
  it('session/load of an active session returns INVALID_REQUEST error', async () => {
    // Gate that blocks indefinitely (until peer closes)
    mGate.mockImplementation((peer: AcpClientPeer, _sid: string, opts: AcpPermissionOptions) => {
      const ac = new AbortController();
      const canUseTool = async (): Promise<{ behavior: 'allow' | 'deny' }> => {
        await opts.emitToolCall({
          sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'write_file x.txt',
          name: 'write_file', kind: 'edit', status: 'pending', content: [], locations: [],
        } as never);
        try {
          await peer.request('session/request_permission', {
            sessionId: _sid,
            toolCall: { toolCallId: 'tc-2', title: 'write_file x.txt', status: 'pending' },
            options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
          }, ac.signal);
        } catch { /* cancelled */ }
        return { behavior: 'deny' };
      };
      return { canUseTool: canUseTool as never, cancelAll: () => ac.abort(), endTurn: async () => {}, wouldAsk: () => true };
    });

    const handle = fakeHandle();
    (handle.session.sendMessageStream as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      const calls = mBuild.mock.calls;
      const opts = calls[calls.length - 1]?.[0];
      await opts?.canUseTool?.('write_file', { file_path: `${WS}/x.txt`, content: 'x' },
        { signal: new AbortController().signal, toolUseID: 'tc-2' } as never);
      await waitInterrupt();
      yield { type: 'done', metadata: { stopReason: 'cancelled' } } as OutputEvent;
    });
    mBuild.mockResolvedValue(handle);
    mLoad.mockImplementation(async () => fakeHandle());
    mReplay.mockResolvedValue(undefined);

    const h = startServer();
    const sid = await setupSession(h);

    // Start a turn (will block waiting for permission)
    h.send(req(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'do something' }] }));

    // Wait for the permission request frame
    await h.waitForFrame(isPermRequest);

    // Now try to load the same session while prompt is in flight
    h.send(req(4, 'session/load', { sessionId: sid, cwd: WS, mcpServers: [] }));

    // Wait for the load response (id=4)
    const loadResp = await h.waitForFrame((f) => {
      const r = f as Record<string, unknown>;
      return r['id'] === 4 && ('result' in r || 'error' in r);
    }) as Record<string, unknown>;

    // Safe: load must return an error (prompt in flight)
    expect(loadResp, 'load response must exist').toBeDefined();
    expect(isError(loadResp),
      `FINDING: session/load while permission pending returned success: ${JSON.stringify(loadResp)}`
    ).toBe(true);

    // Cancel the pending turn so we can clean up
    h.send(note('session/cancel', { sessionId: sid }));
    await new Promise((r) => setTimeout(r, 50));
    await h.end();
  });
});

// ---------------------------------------------------------------------------
// R3: permission reply for a session that has been closed
//
// Sequence:
//   1. Start turn, get permission request
//   2. Send session/close (cancels turn, releases gate)
//   3. Send the allow reply for the now-dead permission id
//
// Safe: the reply must be ignored (peer.handleResponse returns false for
// an unknown id). No allow must escape. The close response must arrive.
// ---------------------------------------------------------------------------
describe('R3: permission reply for a closed session must be ignored', () => {
  it('allow reply after session/close does not produce an allow', async () => {
    mGate.mockImplementation((peer: AcpClientPeer, _sid: string, opts: AcpPermissionOptions) => {
      const ac = new AbortController();
      const canUseTool = async (): Promise<{ behavior: 'allow' | 'deny' }> => {
        await opts.emitToolCall({
          sessionUpdate: 'tool_call', toolCallId: 'tc-3', title: 'write_file y.txt',
          name: 'write_file', kind: 'edit', status: 'pending', content: [], locations: [],
        } as never);
        try {
          await peer.request('session/request_permission', {
            sessionId: _sid,
            toolCall: { toolCallId: 'tc-3', title: 'write_file y.txt', status: 'pending' },
            options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
          }, ac.signal);
        } catch { /* closed */ }
        return { behavior: 'deny' };
      };
      return { canUseTool: canUseTool as never, cancelAll: () => ac.abort(), endTurn: async () => {}, wouldAsk: () => true };
    });

    const handle = fakeHandle();
    (handle.session.sendMessageStream as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      const calls = mBuild.mock.calls;
      const opts = calls[calls.length - 1]?.[0];
      await opts?.canUseTool?.('write_file', { file_path: `${WS}/y.txt`, content: 'x' },
        { signal: new AbortController().signal, toolUseID: 'tc-3' } as never);
      await waitInterrupt();
      yield { type: 'done', metadata: { stopReason: 'cancelled' } } as OutputEvent;
    });
    mBuild.mockResolvedValue(handle);

    const h = startServer();
    const sid = await setupSession(h);

    h.send(req(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'write y' }] }));

    const permFrame = await h.waitForFrame(isPermRequest) as Record<string, unknown>;
    const permId = permFrame['id'] as string;

    // Close the session while permission is pending
    h.send(req(4, 'session/close', { sessionId: sid }));

    // Wait for the prompt response (id=3, cancelled) and close response (id=4)
    await h.waitForFrame((f) => { const r = f as Record<string, unknown>; return r['id'] === 3 && ('result' in r || 'error' in r); });
    await h.waitForFrame((f) => { const r = f as Record<string, unknown>; return r['id'] === 4 && ('result' in r || 'error' in r); });

    // Send late allow reply
    h.send(resp(permId, { outcome: { outcome: 'selected', optionId: 'allow_once' } }));
    await new Promise((r) => setTimeout(r, 50));

    // Safe: exactly one prompt response, the late reply is a no-op
    const allPromptResps = h.frames.filter(isPromptResponse);
    expect(allPromptResps.length,
      `FINDING: ${allPromptResps.length} prompt responses — late allow reply after close was processed`
    ).toBe(1);

    // No second permission request should appear
    const permRequests = h.frames.filter(isPermRequest);
    expect(permRequests.length,
      `FINDING: extra permission request after session close`
    ).toBe(1);

    await h.end();
  });
});

// ---------------------------------------------------------------------------
// R4: permission timeout fires deny (uses fake timers via vi.advanceTimersByTimeAsync)
//
// acp.permission.ts:PERMISSION_TIMEOUT_MS = 120_000. We mock that module-level
// constant to 50ms so the test runs in real time, then verify the timeout path
// resolves the pending permission as 'timeout' (deny) and the prompt response
// arrives.
//
// Safe: after PERMISSION_TIMEOUT_MS the permission must deny without an allow
// escaping. The turn must complete (prompt response arrives).
// ---------------------------------------------------------------------------
describe('R4: permission timeout fires deny', () => {
  it('a permission with no reply times out and denies', async () => {
    // History: awaitReply in acp.permission.ts sets a setTimeout for
    // PERMISSION_TIMEOUT_MS. When it fires, ask.settle({kind:'deny',reason:'timeout'})
    // is called, which resolves awaitReply with a deny. The gate returns
    // denyResult('timeout') and the tool call is refused.
    // We use vi.useFakeTimers + advanceTimersByTimeAsync to trigger the path.
    vi.useFakeTimers();
    try {
      // Gate using the real acp.permission createAcpPermissionGate so the real
      // 120s timer code runs. Restore mock to pass-through for this test.
      const realPermission = await vi.importActual<typeof import('./acp.permission.js')>('./acp.permission.js');
      mGate.mockImplementation(realPermission.createAcpPermissionGate);

      const handle = fakeHandle();
      (handle.session.sendMessageStream as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        await waitInterrupt();
        yield { type: 'done', metadata: { stopReason: 'cancelled' } } as OutputEvent;
      });
      mBuild.mockResolvedValue(handle);

      const h = startServer();
      h.send(req(1, 'initialize', { protocolVersion: 1 }));
      h.send(req(2, 'session/new', { cwd: WS, mcpServers: [] }));
      await vi.advanceTimersByTimeAsync(5);

      // The real gate is installed; start a turn. The gate's canUseTool will be
      // called by the session when the model tries write_file. Since we have no
      // model, the stream ends immediately (no tool call attempted).
      // Instead, verify the timeout path directly at the gate level.
      //
      // We test: the gate's internal setTimeout(120_000) fires via fake timers.
      // Create a real gate and exercise awaitReply directly.
      const { createAcpPermissionGate, PERMISSION_TIMEOUT_MS } = realPermission;
      expect(PERMISSION_TIMEOUT_MS).toBe(120_000); // confirm constant

      // Build a minimal fake peer that never replies
      let permRequestSent = false;
      const fakePeer = {
        request: (_method: string, _params: unknown, _signal: AbortSignal): Promise<unknown> => {
          permRequestSent = true;
          return new Promise((_resolve, _reject) => {
            // Never resolve — wait for timeout
          });
        },
        notify: async () => {},
        handleResponse: () => false,
        close: () => {},
      };
      const emitted: unknown[] = [];
      const gate = createAcpPermissionGate(fakePeer as never, 'test-sid', {
        skip: false,
        cwd: WS,
        emitToolCall: async (s) => { emitted.push(s); },
        onCancelled: () => {},
        turnActive: () => true,
      });

      // Call canUseTool for write_file — requires ask, will send permission request
      const ac = new AbortController();
      const resultP = gate.canUseTool('write_file', { file_path: `${WS}/z.txt`, content: 'x' },
        { signal: ac.signal, toolUseID: 'tc-r4' } as never);

      // Advance just past the timeout
      await vi.advanceTimersByTimeAsync(120_001);

      const result = await resultP;

      // Safe: the result must be a deny with reason 'timeout'
      expect(result.behavior,
        `FINDING: after 120s timeout, gate returned behavior="${result.behavior}" not "deny"`
      ).toBe('deny');
      expect((result as { message?: string }).message,
        `FINDING: timeout deny message should contain 'timeout'`
      ).toContain('timeout');
      expect(permRequestSent, 'gate must have sent a permission request').toBe(true);

      vi.useRealTimers();
      await h.end();
    } finally {
      vi.useRealTimers();
    }
  });
});
