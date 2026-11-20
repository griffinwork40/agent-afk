/**
 * Load/resume integration across A1 handlers, A4 load + durable id map and
 * the real journal: only session construction is scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../../config/env.js';
import { fakeHandle, ScriptedSession } from './__test-utils__/acp-fake-session.js';
import { scriptFor } from './__test-utils__/acp-scripts.js';
import { GoldenConnection } from './__test-utils__/acp-replay.js';
import { seedHistory } from './__test-utils__/acp-history.js';
import type { Frame } from './__test-utils__/acp-frame-schema.js';

vi.mock('./acp.session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./acp.session.js')>();
  return { ...actual, buildAcpSession: vi.fn() };
});
import { buildAcpSession } from './acp.session.js';

const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
let root: string;
let connection: GoldenConnection | undefined;

/** A real AgentSession reports the provider-issued id once the provider replaces the seed. */
class ReplacedIdSession extends ScriptedSession {
  override getSessionIdentity() { return { ...super.getSessionIdentity(), sessionId: PROVIDER_ID }; }
  override getSessionMetadata() { return { ...super.getSessionMetadata(), sessionId: PROVIDER_ID }; }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acp-restore-')));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(path.join(root, 'state'));
  vi.mocked(buildAcpSession).mockReset();
});
afterEach(async () => {
  try { await connection?.close(); } finally {
    connection = undefined;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

async function exchange(c: GoldenConnection, frames: Frame[], from: number): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const [i, frame] of frames.entries()) {
    c.send(frame);
    out.push(await c.frameAt(from + i, `restore step ${i}`));
  }
  return out;
}
const init: Frame = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };

describe('ACP restore through the real load module', () => {
  it('unknown session id on load and resume is resource not found, not internal error', async () => {
    connection = new GoldenConnection();
    const missing = '33333333-3333-4333-8333-333333333333';
    const [, load, resume] = await exchange(connection, [init,
      { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: missing, cwd: root, mcpServers: [] } },
      { jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: missing, cwd: root } },
    ], 0);
    expect(load).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32002, message: 'Resource not found' } });
    expect(resume).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32002, message: 'Resource not found' } });
    expect(buildAcpSession).not.toHaveBeenCalled();
  });

  it('a provider-replaced session id is mapped durably so a later load finds its history', async () => {
    const script = scriptFor('resume', root);
    vi.mocked(buildAcpSession).mockImplementation(async options => {
      const handle = fakeHandle(options, script);
      return { ...handle, session: new ReplacedIdSession(options, script) } as unknown as typeof handle;
    });
    connection = new GoldenConnection();
    const [, created] = await exchange(connection, [init,
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: root, mcpServers: [] } }], 0);
    const acpId = (created!['result'] as { sessionId: string }).sessionId;
    expect(acpId).not.toBe(PROVIDER_ID);
    const turn = await exchange(connection, [{ jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: acpId, prompt: [{ type: 'text', text: 'Continue' }] } }], 2);
    expect(turn[0]!['method']).toBe('session/update');
    await connection.frameAt(3, 'prompt response');
    await connection.close();

    // The provider journalled under its own id; the wire id must still resolve to it.
    seedHistory(root, PROVIDER_ID);
    connection = new GoldenConnection();
    const [, first] = await exchange(connection, [init,
      { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: acpId, cwd: root, mcpServers: [] } }], 0);
    expect(first).toEqual({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acpId,
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Read a.txt' } } } });
    await connection.frameAt(4, 'load response');
    expect(connection.frames[4]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(vi.mocked(buildAcpSession).mock.calls.at(-1)![0]).toMatchObject({ resume: PROVIDER_ID, sessionId: acpId });
  });
});
