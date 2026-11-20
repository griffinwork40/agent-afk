/**
 * Red team 2b: races against the real JSON-RPC peer (createAcpRpcPeer) and the
 * real gate. These HELD on 6f18f96c7; kept as evidence for the report.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAcpRpcPeer } from './acp.rpc-peer.js';
import { createAcpPermissionGate } from './acp.permission.js';

const CWD = path.resolve('/workspace/proj');
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function setup() {
  const frames: any[] = [];
  const peer = createAcpRpcPeer({ write: async (f: unknown) => { frames.push(f); } } as any);
  const gate = createAcpPermissionGate(peer, 'sid', {
    skip: false, cwd: CWD, onCancelled: vi.fn(), emitToolCall: vi.fn(async () => {}), turnActive: () => true,
  });
  const reqs = () => frames.filter((f) => f.method === 'session/request_permission');
  const reply = (id: unknown, optionId: string) => peer.handleResponse({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } } as any);
  return { peer, gate, reqs, reply };
}
const w = (p: string) => ({ file_path: p, content: 'x' });

describe('redteam2b races (held)', () => {
  it('reply after cancelAll is ignored; nothing remembered', async () => {
    const t = setup();
    const p = t.gate.canUseTool('write_file', w('a'), { signal: new AbortController().signal, toolUseID: 'a' });
    await flush();
    t.gate.cancelAll();
    expect(t.reply(t.reqs()[0].id, 'allow_always')).toBe(false);
    expect((await p).behavior).toBe('deny');
    const q = t.gate.canUseTool('write_file', w('b'), { signal: new AbortController().signal, toolUseID: 'b' });
    await flush();
    expect(t.reqs()).toHaveLength(2);
    t.reply(t.reqs()[1].id, 'reject_once');
    expect((await q).behavior).toBe('deny');
  });

  it('reply after abort is ignored', async () => {
    const t = setup();
    const ac = new AbortController();
    const p = t.gate.canUseTool('write_file', w('a'), { signal: ac.signal, toolUseID: 'a' });
    await flush();
    ac.abort();
    expect(t.reply(t.reqs()[0].id, 'allow_once')).toBe(false);
    expect((await p).behavior).toBe('deny');
  });

  it('duplicate reply and a reply with another request id cannot cross over', async () => {
    const t = setup();
    const p1 = t.gate.canUseTool('write_file', w('a'), { signal: new AbortController().signal, toolUseID: 'a' });
    const p2 = t.gate.canUseTool('bash', { command: 'rm -rf /' }, { signal: new AbortController().signal, toolUseID: 'b' });
    await flush();
    const [r1, r2] = t.reqs();
    // allow_always is only offered on r1; sending it with r2's id is an unoffered option for bash.
    expect(t.reply(r2.id, 'allow_always')).toBe(true);
    expect(await p2).toMatchObject({ behavior: 'deny', message: 'Permission denied: unknown_option' });
    expect(t.reply(r1.id, 'reject_once')).toBe(true);
    expect(t.reply(r1.id, 'allow_once')).toBe(false); // duplicate ignored
    expect((await p1).behavior).toBe('deny');
  });

  it('peer close while pending denies', async () => {
    const t = setup();
    const p = t.gate.canUseTool('write_file', w('a'), { signal: new AbortController().signal, toolUseID: 'a' });
    await flush();
    t.peer.close('eof');
    expect(await p).toMatchObject({ behavior: 'deny', message: 'Permission denied: peer_closed' });
  });
});
