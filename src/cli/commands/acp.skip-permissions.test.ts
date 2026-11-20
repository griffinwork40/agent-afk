/**
 * Item 5 [C6]: settle the review claim that --dangerously-skip-permissions
 * removes tool_call frames entirely.
 *
 * Reading the code shows the stream translator emits tool_call frames from
 * the output event stream regardless of whether a permission gate exists.
 * The skip flag only controls whether the approval bridge (canUseTool) runs.
 * This test confirms that:
 *
 *   1. A tool_call frame with status in_progress is announced.
 *   2. A tool_call_update frame with status completed is emitted.
 *   3. No session/request_permission is ever sent to the client.
 *   4. The tool executes (the script records execution).
 *
 * @module cli/commands/acp.skip-permissions.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../../config/env.js';
import { fakeHandle, ScriptedSession } from './__test-utils__/acp-fake-session.js';
import { scriptFor } from './__test-utils__/acp-scripts.js';

vi.mock('./acp.session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./acp.session.js')>();
  return { ...actual, buildAcpSession: vi.fn() };
});
import { buildAcpSession } from './acp.session.js';

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { runAcpServer } from './acp.server.js';
import { getVersion } from '../version.js';

type Frame = Record<string, unknown>;

/** Minimal inline connection that records every agent frame. */
class SkipPermissionsConnection {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly frames: Frame[] = [];
  private changed?: () => void;
  private stopped = false;
  private serverError?: unknown;
  private readonly reader = createInterface({ input: this.output, crlfDelay: Infinity });
  private readonly done: Promise<void>;

  constructor(dangerouslySkipPermissions: boolean) {
    this.reader.on('line', line => {
      this.frames.push(JSON.parse(line) as Frame);
      this.changed?.();
    });
    this.done = runAcpServer({
      model: 'o3', maxTurns: 10,
      input: this.input, output: this.output,
      dangerouslySkipPermissions,
    })
      .catch((err: unknown) => { this.serverError = err; })
      .finally(() => { this.stopped = true; this.changed?.(); });
  }

  send(frame: Frame): void { this.input.write(`${JSON.stringify(frame)}\n`); }

  async frameAt(index: number): Promise<Frame> {
    while (!this.frames[index]) {
      if (this.stopped) throw new Error(`server stopped before frame ${index + 1}: ${String(this.serverError)}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.changed = undefined; reject(new Error(`missing frame ${index + 1}`)); }, 2000);
        this.changed = () => { clearTimeout(timer); this.changed = undefined; resolve(); };
      });
    }
    return this.frames[index]!;
  }

  async close(): Promise<void> {
    this.input.end();
    await Promise.race([this.done, new Promise<never>((_r, reject) => {
      const t = setTimeout(() => reject(new Error('server close hung')), 2000);
      t.unref();
      void this.done.then(() => clearTimeout(t));
    })]);
    this.reader.close();
    this.input.destroy();
    this.output.destroy();
    if (this.serverError) throw this.serverError;
  }
}

let temporaryRoot: string;
let sessions: ScriptedSession[];

beforeEach(() => {
  temporaryRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-skip-')));
  sessions = [];
  vi.spyOn(process, 'cwd').mockReturnValue(temporaryRoot);
  vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(path.join(temporaryRoot, 'state'));
  vi.mocked(buildAcpSession).mockReset();
});

afterEach(async () => {
  for (const s of sessions) s.abort();
  vi.restoreAllMocks();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('[C6] --dangerously-skip-permissions does not remove tool_call frames', () => {
  it('announces and completes the tool call, sends no session/request_permission', async () => {
    const script = scriptFor('tool-read', temporaryRoot);
    vi.mocked(buildAcpSession).mockImplementation(async options => {
      const handle = fakeHandle(options, script);
      sessions.push(handle.session as unknown as ScriptedSession);
      return handle;
    });

    const conn = new SkipPermissionsConnection(true);
    const version = getVersion();
    const sub = (v: unknown): unknown => {
      if (typeof v === 'string') return v.replace(/\/workspace(?:\/([\w.-]+))?/g, (_m, f?: string) => f ? path.join(temporaryRoot, f) : temporaryRoot);
      if (Array.isArray(v)) return v.map(sub);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, k === 'version' ? version : sub(val)]));
      return v;
    };

    // initialize
    conn.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
    const initResp = await conn.frameAt(0);
    expect(initResp['result']).toMatchObject({ protocolVersion: 1 });

    // session/new
    conn.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: temporaryRoot, mcpServers: [] } });
    const newResp = await conn.frameAt(1);
    const sessionId = (newResp['result'] as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe('string');

    // session/prompt
    conn.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Read a.txt' }] } });

    // Frame 2: tool_call with status in_progress (skip means no pending gate step).
    const toolCall = await conn.frameAt(2);
    expect(toolCall['method']).toBe('session/update');
    const update = (toolCall['params'] as { update: Record<string, unknown> }).update;
    expect(update['sessionUpdate']).toBe('tool_call');
    expect(update['status']).toBe('in_progress');
    expect(update['toolCallId']).toBe('tool-1');

    // Frame 3: tool_call_update with status completed.
    const toolDone = await conn.frameAt(3);
    expect(toolDone['method']).toBe('session/update');
    const doneUpdate = (toolDone['params'] as { update: Record<string, unknown> }).update;
    expect(doneUpdate['sessionUpdate']).toBe('tool_call_update');
    expect(doneUpdate['status']).toBe('completed');

    // Frame 4: prompt result.
    const result = await conn.frameAt(4);
    expect(result['id']).toBe(3);
    expect((result['result'] as { stopReason: string }).stopReason).toBe('end_turn');

    // No session/request_permission was ever sent.
    const permFrames = conn.frames.filter(f => f['method'] === 'session/request_permission');
    expect(permFrames, 'no permission request should be sent with --dangerously-skip-permissions').toHaveLength(0);

    // The tool actually executed.
    expect(script.executed).toEqual(['tool-1']);

    await conn.close();
  });
});
