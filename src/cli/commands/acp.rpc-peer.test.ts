import { describe, it, expect } from 'vitest';
import { AcpPeerClosedError, createAcpRpcPeer } from './acp.rpc-peer.js';
import type { RpcFrame } from './acp.wire.js';

function harness(fail = false) {
  const frames: RpcFrame[] = [];
  const peer = createAcpRpcPeer({
    write: async (f) => {
      if (fail) throw new Error('EPIPE');
      frames.push(f);
    },
  });
  return { peer, frames };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('acp rpc peer', () => {
  it('sends requests with acp:N ids and resolves on matching response', async () => {
    const { peer, frames } = harness();
    const p1 = peer.request('session/request_permission', { a: 1 });
    const p2 = peer.request('session/request_permission', { a: 2 });
    await tick();
    expect(frames.map((f) => (f as { id: string }).id)).toEqual(['acp:1', 'acp:2']);
    expect(peer.handleResponse({ jsonrpc: '2.0', id: 'acp:2', result: { ok: 2 } })).toBe(true);
    expect(peer.handleResponse({ jsonrpc: '2.0', id: 'acp:1', result: { ok: 1 } })).toBe(true);
    await expect(p1).resolves.toEqual({ ok: 1 });
    await expect(p2).resolves.toEqual({ ok: 2 });
  });

  it('ignores unknown, late, and wrong-direction ids', async () => {
    const { peer } = harness();
    const p = peer.request('m', {});
    await tick();
    expect(peer.handleResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    expect(peer.handleResponse({ jsonrpc: '2.0', id: 'acp:99', result: {} })).toBe(false);
    expect(peer.handleResponse({ jsonrpc: '2.0', id: 'acp:1', result: 'x' })).toBe(true);
    await p;
    expect(peer.handleResponse({ jsonrpc: '2.0', id: 'acp:1', result: 'x' })).toBe(false);
  });

  it('rejects on a client error response', async () => {
    const { peer } = harness();
    const p = peer.request('m', {});
    await tick();
    peer.handleResponse({ jsonrpc: '2.0', id: 'acp:1', error: { code: -32603, message: 'boom' } });
    await expect(p).rejects.toThrow();
  });

  it('rejects immediately when the signal is already aborted, without writing', async () => {
    const { peer, frames } = harness();
    const ac = new AbortController();
    ac.abort();
    await expect(peer.request('m', {}, ac.signal)).rejects.toThrow();
    expect(frames).toHaveLength(0);
  });

  it('rejects and forgets the id when aborted while pending', async () => {
    const { peer } = harness();
    const ac = new AbortController();
    const p = peer.request('m', {}, ac.signal);
    await tick();
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(peer.handleResponse({ jsonrpc: '2.0', id: 'acp:1', result: {} })).toBe(false);
  });

  it('close rejects all pending and prohibits new writes', async () => {
    const { peer, frames } = harness();
    const p = peer.request('m', {});
    await tick();
    peer.close('eof');
    await expect(p).rejects.toThrow(/eof/);
    await expect(peer.request('m', {})).rejects.toThrow();
    await expect(peer.notify('n', {})).rejects.toThrow();
    expect(frames).toHaveLength(1);
  });

  it('closed-peer rejections are the exported typed error, not a message convention', async () => {
    const { peer } = harness();
    const p = peer.request('m', {});
    await tick();
    peer.close('eof');
    await expect(p).rejects.toBeInstanceOf(AcpPeerClosedError);
    await expect(peer.request('m', {})).rejects.toBeInstanceOf(AcpPeerClosedError);
    const failed = harness(true).peer;
    // A write failure closes the peer, so the in-flight request is also a closed-peer rejection.
    await expect(failed.request('first', {})).rejects.toBeInstanceOf(AcpPeerClosedError);
    await expect(failed.request('after', {})).rejects.toBeInstanceOf(AcpPeerClosedError);
  });

  it('a write failure rejects the request and every pending request', async () => {
    const { peer } = harness(true);
    await expect(peer.request('m', {})).rejects.toThrow();
    await expect(peer.notify('n', {})).rejects.toThrow();
  });

  it('notify writes a notification without id', async () => {
    const { peer, frames } = harness();
    await peer.notify('session/update', { x: 1 });
    expect(frames[0]).toEqual({ jsonrpc: '2.0', method: 'session/update', params: { x: 1 } });
  });
});
