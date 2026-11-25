/**
 * Races through the FULL stdio server.
 *
 * Uses real runAcpServer with mocked acp.session / acp.translate /
 * acp.session-load (same pattern as acp.server.test.ts). Tests assert
 * the SAFE behaviour and therefore FAIL when the code is broken.
 *
 * Race under test:
 *   R2 — session/load of a live session while a prompt is active
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OutputEvent } from '../../agent/types/session-types.js';
import type { SessionUpdate } from './acp.wire.js';

vi.mock('./acp.session.js', () => ({ buildAcpSession: vi.fn(), closeAcpSession: vi.fn() }));
vi.mock('./acp.translate.js', () => ({
  createTranslatorState: vi.fn(() => ({ tools: new Map(), cancelled: false })),
  translateOutputEvent: vi.fn((ev: { __acp?: SessionUpdate[] }) => ev.__acp ?? []),
  finishTurn: vi.fn(() => ({ updates: [], stopReason: 'end_turn' })),
}));
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
import * as sessionLoad from './acp.session-load.js';

const mBuild = vi.mocked(acpSession.buildAcpSession);
const mClose = vi.mocked(acpSession.closeAcpSession);
const mFinish = vi.mocked(translate.finishTurn);
const mLoad = vi.mocked(sessionLoad.loadAcpSession);
const mReplay = vi.mocked(sessionLoad.replayHistory);

const WS = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-races-')));
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
      for (;;) {
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

function isError(f: unknown): boolean {
  return typeof f === 'object' && f !== null && 'error' in f;
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
// R2: session/load of a live session while a prompt is active
//
// Profile §2 / acp.handlers.ts: "A prompt in flight ... is invalid request."
// reopenLive throws INVALID_REQUEST when live.active is set.
//
// Safe: the load must fail with an error response (not succeed).
// ---------------------------------------------------------------------------
describe('R2: session/load while prompt active must return error', () => {
  it('session/load of an active session returns INVALID_REQUEST error', async () => {
    const handle = fakeHandle();
    (handle.session.sendMessageStream as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      await waitInterrupt();
      yield { type: 'done', metadata: { stopReason: 'cancelled' } } as OutputEvent;
    });
    mBuild.mockResolvedValue(handle);
    mLoad.mockImplementation(async () => fakeHandle());
    mReplay.mockResolvedValue(undefined);

    const h = startServer();
    const sid = await setupSession(h);

    // Start a turn (will block waiting for interrupt)
    h.send(req(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'do something' }] }));
    // Give the turn time to start
    await new Promise((r) => setTimeout(r, 10));

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
      `FINDING: session/load while prompt active returned success: ${JSON.stringify(loadResp)}`
    ).toBe(true);

    // Cancel the pending turn so we can clean up
    h.send(note('session/cancel', { sessionId: sid }));
    await new Promise((r) => setTimeout(r, 50));
    await h.end();
  });
});
