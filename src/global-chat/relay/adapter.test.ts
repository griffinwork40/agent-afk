import { describe, it, expect, vi } from 'vitest';
import { ChatRoom, HELLO_TIMEOUT_MS, MAX_TOTAL_CONNECTIONS, MAX_PENDING_EVENTS_PER_CONNECTION } from '../../../relay/src/room-object.js';
import { Room } from './room.js';
import { MemoryRelayStore } from './store.js';
import { generateKeyPair, importPrivateKey, sign } from '../crypto.js';
import { canonicalHello, canonicalPost } from '../protocol.js';

class Socket {
  readyState = 1;
  attachment: any;
  sent: any[] = [];
  deserializeAttachment() { return structuredClone(this.attachment); }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}
function setup(count = 2) {
  const sockets = Array.from({ length: count }, (_, i) => {
    const ws = new Socket();
    ws.attachment = { pubkey: null, name: null, ipHash: 'address', helloOk: false,
      _connId: String(i), _helloDeadline: Date.now() + HELLO_TIMEOUT_MS };
    return ws;
  });
  const store = new MemoryRelayStore();
  const ctx = { getWebSockets: () => sockets, storage: { setAlarm: vi.fn(), deleteAlarm: vi.fn() } };
  const object = new ChatRoom(ctx as any, { IP_SALT: 'test-salt-at-least-sixteen', ADMIN_PUBKEYS: '' });
  (object as any).room = new Room(store, { maintainerKeys: [], maxConnsPerIp: 5 }, { now: Date.now });
  return { object, sockets, store, ctx };
}
async function hello(name: string) {
  const kp = await generateKeyPair();
  const privateKey = await importPrivateKey(kp.privateKeyPkcs8);
  const fields = { pubkey: kp.pubkey, name, ts: Date.now() };
  const frame = { t: 'hello', v: 1, ...fields, sig: await sign(canonicalHello(fields), privateKey) };
  return { kp, privateKey, frame: JSON.stringify(frame) };
}
const send = (object: ChatRoom, socket: Socket, frame: string) => object.webSocketMessage(socket as any, frame);

describe('Durable Object event serialization', () => {
  it('rejects oversized UTF-8 input before enqueueing', async () => {
    const { object, sockets } = setup(1);
    await send(object, sockets[0]!, 'é'.repeat(2049));
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets[0]!.sent).toEqual([]);
  });

  it('closes a flooding socket and lets another connection progress', async () => {
    const { object, sockets } = setup(2);
    const tasks = Array.from({ length: MAX_PENDING_EVENTS_PER_CONNECTION + 1 }, () =>
      send(object, sockets[0]!, '{"t":"ping","n":1}'));
    expect(sockets[0]!.readyState).toBe(3);
    await Promise.all(tasks);
    await send(object, sockets[1]!, '{"t":"ping","n":2}');
    expect(sockets[1]!.sent).toContainEqual({ t: 'pong', n: 2 });
  });
  it('serializes overlapping crypto awaits before taking the next connection snapshot', async () => {
    const { object, sockets } = setup();
    const [a, b] = await Promise.all([hello('alice'), hello('bob')]);
    await Promise.all([send(object, sockets[0]!, a.frame), send(object, sockets[1]!, b.frame)]);
    expect(sockets[0]!.sent.filter(f => f.t === 'presence').map(f => f.online)).toEqual([1, 2]);
    expect(sockets[1]!.sent.find(f => f.t === 'welcome').online).toBe(2);
  });

  it('rejects the second concurrent post with the same id instead of broadcasting twice', async () => {
    const { object, sockets } = setup(1);
    const a = await hello('alice');
    await send(object, sockets[0]!, a.frame);
    const fields = { id: '1'.repeat(32), ts: Date.now(), name: 'alice', text: 'one post' };
    const frame = JSON.stringify({ t: 'post', id: fields.id, ts: fields.ts, text: fields.text,
      sig: await sign(canonicalPost(fields), a.privateKey) });
    await Promise.all([send(object, sockets[0]!, frame), send(object, sockets[0]!, frame)]);
    expect(sockets[0]!.sent.filter(f => f.t === 'msg')).toHaveLength(1);
    expect(sockets[0]!.sent.find(f => f.code === 'duplicate')).toBeDefined();
  });

  it('continues after a rejected queued event', async () => {
    const { object, sockets } = setup(1);
    const original = sockets[0]!.deserializeAttachment;
    sockets[0]!.deserializeAttachment = () => { throw new Error('test'); };
    await expect(send(object, sockets[0]!, '{}')).rejects.toThrow('test');
    sockets[0]!.deserializeAttachment = original;
    await send(object, sockets[0]!, JSON.stringify({ t: 'ping', n: 1 }));
    expect(sockets[0]!.sent).toContainEqual({ t: 'pong', n: 1 });
  });
});

describe('Durable Object admission and lifecycle', () => {
  it.each(['', 'short'])('fails closed for invalid IP_SALT %j', async salt => {
    const { ctx } = setup(0);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const object = new ChatRoom(ctx as any, { IP_SALT: salt, ADMIN_PUBKEYS: '' });
      const response = await object.fetch(new Request('http://local/', { headers: { Upgrade: 'websocket' } }));
      expect(response.status).toBe(503);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('IP_SALT'));
    } finally { log.mockRestore(); }
  });

  it('caps all sockets, including those without hello, before accepting', async () => {
    const { object } = setup(MAX_TOTAL_CONNECTIONS);
    const response = await object.fetch(new Request('http://local/', { headers: { Upgrade: 'websocket' } }));
    expect(response.status).toBe(503);
  });

  it('caps pending sockets per address hash before accepting', async () => {
    const { object, sockets } = setup(5);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-salt-at-least-sixteenunknown'));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    for (const socket of sockets) socket.attachment.ipHash = hash;
    const response = await object.fetch(new Request('http://local/', { headers: { Upgrade: 'websocket' } }));
    expect(response.status).toBe(429);
  });

  it('alarm closes expired pending sockets and re-arms the earliest remaining deadline', async () => {
    const { object, sockets, ctx } = setup(2);
    sockets[0]!.attachment._helloDeadline = Date.now() - 1;
    const next = Date.now() + 9000;
    sockets[1]!.attachment._helloDeadline = next;
    await object.alarm();
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets[1]!.readyState).toBe(1);
    expect(ctx.storage.setAlarm).toHaveBeenCalledWith(next);
  });

  it('rejects late hello even if alarm delivery has been delayed', async () => {
    const { object, sockets } = setup(1);
    sockets[0]!.attachment._helloDeadline = Date.now() - 1;
    await send(object, sockets[0]!, (await hello('alice')).frame);
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets[0]!.sent).toEqual([]);
  });

  it('excludes closed attachments from subsequent hello and presence', async () => {
    const { object, sockets } = setup(2);
    await send(object, sockets[0]!, (await hello('alice')).frame);
    await object.webSocketClose(sockets[0] as any, 1000, '', true);
    await send(object, sockets[1]!, (await hello('bob')).frame);
    expect(sockets[0]!.attachment._closed).toBe(true);
    expect(sockets[1]!.sent.find(f => f.t === 'welcome').online).toBe(1);
  });
});
