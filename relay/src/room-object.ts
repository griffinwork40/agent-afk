import { Room, countDistinctKeys } from '../../src/global-chat/relay/room.js';
import { SqliteRelayStore } from './sqlite-store.js';
import type { ConnRecord, RelayConfig, RoomEffect } from '../../src/global-chat/relay/room-types.js';
import type { RoomMode } from '../../src/global-chat/protocol.js';
import { realClock } from '../../src/global-chat/relay/limiter.js';

// Contract:
// Every event joins one queue, including accept, close, error and alarm. DO input
// gates protect storage awaits, NOT crypto awaits. Read attachments only once
// the event owns the turn. An outstanding event promise prevents hibernation.
// Attachments and the persistent storage alarm survive hibernation; in-memory
// rate counters may reset. Raw addresses are never stored or logged.

export const MAX_TOTAL_CONNECTIONS = 500;
export const HELLO_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS_PER_IP = 5;

interface Env {
  ADMIN_PUBKEYS: string;
  IP_SALT: string;
  ROOM_NOTICE?: string;
  ROOM_MODE?: string;
}
interface Attachment extends ConnRecord {
  _connId: string;
  _helloDeadline: number;
  _closed?: boolean;
}

function parseConfig(env: Env): RelayConfig {
  const maintainerKeys = env.ADMIN_PUBKEYS
    ? env.ADMIN_PUBKEYS.split(',').map(k => k.trim()).filter(k => /^[0-9a-f]{64}$/.test(k))
    : [];
  const forcedMode = (env.ROOM_MODE === 'open' || env.ROOM_MODE === 'readonly' || env.ROOM_MODE === 'closed')
    ? env.ROOM_MODE as RoomMode : undefined;
  return { maintainerKeys, notice: env.ROOM_NOTICE || undefined, forcedMode, maxConnsPerIp: MAX_CONNECTIONS_PER_IP };
}

async function hashIp(salt: string, ip: string): Promise<string> {
  const data = new TextEncoder().encode(salt + ip);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export class ChatRoom implements DurableObject {
  private room: Room | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    // One rejected event must not poison all subsequent events.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private getRoom(): Room {
    if (!this.room) {
      const store = new SqliteRelayStore(this.ctx.storage.sql);
      store.ensureSchema();
      this.room = new Room(store, parseConfig(this.env), realClock);
    }
    return this.room;
  }

  private sockets(): WebSocket[] {
    // getWebSockets can include sockets whose closing handshake is unfinished.
    return this.ctx.getWebSockets().filter(ws => ws.readyState === 1 && !this.record(ws)?._closed);
  }

  private record(ws: WebSocket): Attachment | null {
    return ws.deserializeAttachment() as Attachment | null;
  }

  private buildAllConns(): Map<string, ConnRecord> {
    const all = new Map<string, ConnRecord>();
    for (const ws of this.sockets()) {
      const rec = this.record(ws);
      if (rec) all.set(rec._connId, rec);
    }
    return all;
  }

  fetch(request: Request): Promise<Response> {
    return this.enqueue(async () => {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      if (!this.env.IP_SALT || this.env.IP_SALT.length < 16) {
        console.error('Chat relay unavailable: IP_SALT must contain at least 16 characters');
        return new Response('Relay configuration error: IP_SALT must contain at least 16 characters', { status: 503 });
      }
      const ipHash = await hashIp(this.env.IP_SALT, request.headers.get('CF-Connecting-IP') ?? 'unknown');
      const conns = this.buildAllConns();
      if (conns.size >= MAX_TOTAL_CONNECTIONS) return new Response('Room connection limit reached', { status: 503 });
      if ([...conns.values()].filter(c => c.ipHash === ipHash).length >= MAX_CONNECTIONS_PER_IP) {
        return new Response('Address connection limit reached', { status: 429 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      const connId = generateConnId();
      const conn = this.getRoom().onConnect(connId, ipHash);
      server.serializeAttachment({ ...conn, _connId: connId, _helloDeadline: Date.now() + HELLO_TIMEOUT_MS });
      this.ctx.acceptWebSocket(server);
      await this.scheduleDeadline();
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.enqueue(async () => {
      if (typeof message !== 'string') return;
      const rec = this.record(ws);
      if (!rec || rec._closed || ws.readyState !== 1) return;
      if (!rec.helloOk && Date.now() >= rec._helloDeadline) {
        this.closeSocket(ws, 1008, 'Hello deadline exceeded');
        await this.scheduleDeadline();
        return;
      }
      const allConns = this.buildAllConns();
      const effect = await this.getRoom().onMessage(rec._connId, message, rec, allConns);
      this.applyEffect(ws, rec._connId, effect);
      await this.scheduleDeadline();
    });
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    return this.enqueue(() => this.handleClose(ws, 1000));
  }

  webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    return this.enqueue(() => this.handleClose(ws, 1011));
  }

  private async handleClose(ws: WebSocket, code: number): Promise<void> {
    const rec = this.record(ws);
    if (!rec || rec._closed) return;
    const allConns = this.buildAllConns();
    allConns.set(rec._connId, rec);
    const effect = await this.getRoom().onClose(rec._connId, rec, allConns);
    // Finish the closing handshake; do not count a stale attachment as online.
    this.closeSocket(ws, code, 'Connection closed');
    this.applyEffect(ws, rec._connId, effect);
    await this.scheduleDeadline();
  }

  alarm(): Promise<void> {
    return this.enqueue(async () => {
      for (const ws of this.sockets()) {
        const rec = this.record(ws);
        if (rec && !rec.helloOk && Date.now() >= rec._helloDeadline) {
          this.closeSocket(ws, 1008, 'Hello deadline exceeded');
        }
      }
      await this.scheduleDeadline();
    });
  }

  private async scheduleDeadline(): Promise<void> {
    let next = Infinity;
    for (const ws of this.sockets()) {
      const rec = this.record(ws);
      if (rec && !rec.helloOk) next = Math.min(next, rec._helloDeadline);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    const rec = this.record(ws);
    if (rec) ws.serializeAttachment({ ...rec, _closed: true });
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  private broadcast(frames: RoomEffect['toBroadcast']): void {
    const encoded = frames.map(frame => JSON.stringify(frame));
    for (const ws of this.sockets()) {
      if (!this.record(ws)?.helloOk) continue;
      for (const frame of encoded) {
        try { ws.send(frame); } catch { /* closing socket */ }
      }
    }
  }

  private applyEffect(senderWs: WebSocket, connId: string, effect: RoomEffect): void {
    senderWs.serializeAttachment({ ...this.record(senderWs), ...effect.conn, _connId: connId });
    for (const frame of effect.toSender) {
      try { senderWs.send(JSON.stringify(frame)); } catch { /* closing socket */ }
    }
    const before = countDistinctKeys(this.buildAllConns());
    const toClose = new Set(effect.toClose);
    for (const ws of this.sockets()) {
      const rec = this.record(ws);
      if (rec) {
        for (const target of effect.toConnections ?? []) {
          if (target.connId === rec._connId) {
            try { ws.send(JSON.stringify(target.frame)); } catch { /* closing socket */ }
          }
        }
        if (toClose.has(rec._connId)) this.closeSocket(ws, 1008, 'Connection closed by relay');
      }
    }
    this.broadcast(effect.toBroadcast);
    const after = countDistinctKeys(this.buildAllConns());
    if (after !== before) this.broadcast([{ t: 'presence', online: after }]);
  }
}

function generateConnId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)),
    b => b.toString(16).padStart(2, '0')).join('');
}
