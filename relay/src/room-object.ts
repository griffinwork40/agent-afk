import { Room } from '../../src/global-chat/relay/room.js';
import { SqliteRelayStore } from './sqlite-store.js';
import type { ConnRecord, RelayConfig, RoomEffect } from '../../src/global-chat/relay/room-types.js';
import type { RoomMode } from '../../src/global-chat/protocol.js';
import { realClock } from '../../src/global-chat/relay/limiter.js';

// Contract:
// ChatRoom uses the WebSocket Hibernation API (ctx.acceptWebSocket).
// Per-connection state is serialized as the WebSocket attachment so it
// survives DO hibernation. The Room instance itself holds only in-memory
// rate-limit counters; losing them on hibernation is acceptable per the
// brief. All durable state goes through SqliteRelayStore.
//
// IP hashing: SHA-256(salt + CF-Connecting-IP). The raw IP is never stored
// or logged. The salt comes from the IP_SALT secret binding.
//
// Log policy: frame text is never logged. Only structural events (open,
// close, error type) are logged.

interface Env {
  ADMIN_PUBKEYS: string;
  IP_SALT: string;
  ROOM_NOTICE?: string;
  ROOM_MODE?: string;
}

function parseConfig(env: Env): RelayConfig {
  const maintainerKeys = env.ADMIN_PUBKEYS
    ? env.ADMIN_PUBKEYS.split(',').map(k => k.trim()).filter(k => k.length === 64)
    : [];
  const forcedMode = (env.ROOM_MODE === 'open' || env.ROOM_MODE === 'readonly' || env.ROOM_MODE === 'closed')
    ? env.ROOM_MODE as RoomMode
    : undefined;
  return {
    maintainerKeys,
    notice: env.ROOM_NOTICE || undefined,
    forcedMode,
    maxConnsPerIp: 5,
  };
}

async function hashIp(salt: string, ip: string): Promise<string> {
  const data = new TextEncoder().encode(salt + ip);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export class ChatRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private room: Room | null = null;
  private store: SqliteRelayStore | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private getRoom(): Room {
    if (!this.room) {
      this.store = new SqliteRelayStore(this.ctx.storage.sql);
      this.store.ensureSchema();
      this.room = new Room(this.store, parseConfig(this.env), realClock);
    }
    return this.room;
  }

  private buildAllConns(): Map<string, ConnRecord> {
    const all = new Map<string, ConnRecord>();
    for (const ws of this.ctx.getWebSockets()) {
      const rec = ws.deserializeAttachment() as ConnRecord | null;
      if (rec) {
        // Use the WebSocket's serialized id from the attachment
        const id = getWsId(ws);
        all.set(id, rec);
      }
    }
    return all;
  }

  async fetch(request: Request): Promise<Response> {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const ipHash = await hashIp(this.env.IP_SALT ?? '', ip);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    const room = this.getRoom();
    const connId = generateConnId();
    const connRecord = room.onConnect(connId, ipHash);
    // Store connId in attachment so we can recover it
    server.serializeAttachment({ ...connRecord, _connId: connId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return; // binary frames ignored
    const rec = ws.deserializeAttachment() as (ConnRecord & { _connId: string }) | null;
    if (!rec) return;
    const connId = rec._connId;

    const room = this.getRoom();
    const allConns = this.buildAllConns();
    // Ensure current conn is in allConns with latest record
    allConns.set(connId, rec);

    const effect = await room.onMessage(connId, message, rec, allConns);
    await this.applyEffect(ws, connId, effect, allConns);
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const rec = ws.deserializeAttachment() as (ConnRecord & { _connId: string }) | null;
    if (!rec) return;
    const connId = rec._connId;

    const room = this.getRoom();
    const allConns = this.buildAllConns();
    allConns.set(connId, rec);

    const effect = await room.onClose(connId, rec, allConns);
    await this.applyEffect(ws, connId, effect, allConns);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    // Close the socket cleanly; structural error only (no message text logged)
    try { ws.close(1011, 'Internal error'); } catch { /* already closed */ }
  }

  private async applyEffect(
    senderWs: WebSocket,
    connId: string,
    effect: RoomEffect,
    allConns: Map<string, ConnRecord>,
  ): Promise<void> {
    // Update the sender's attachment with the new conn record
    senderWs.serializeAttachment({ ...effect.conn, _connId: connId });

    // Send frames to sender
    for (const frame of effect.toSender) {
      try { senderWs.send(JSON.stringify(frame)); } catch { /* socket may be closing */ }
    }

    // Broadcast to all hello'd connections
    if (effect.toBroadcast.length > 0) {
      const encoded = effect.toBroadcast.map(f => JSON.stringify(f));
      for (const ws of this.ctx.getWebSockets()) {
        const rec = ws.deserializeAttachment() as (ConnRecord & { _connId: string }) | null;
        if (!rec?.helloOk) continue;
        // Skip connections being closed
        if (effect.toClose.includes(rec._connId)) continue;
        for (const msg of encoded) {
          try { ws.send(msg); } catch { /* ignore */ }
        }
      }
    }

    // Close targeted connections
    if (effect.toClose.length > 0) {
      const toCloseSet = new Set(effect.toClose);
      for (const ws of this.ctx.getWebSockets()) {
        const rec = ws.deserializeAttachment() as (ConnRecord & { _connId: string }) | null;
        if (rec && toCloseSet.has(rec._connId)) {
          try { ws.close(1008, 'Connection closed by relay'); } catch { /* already closed */ }
        }
      }
    }

    void allConns; // used for room logic above
  }
}

function getWsId(ws: WebSocket): string {
  const rec = ws.deserializeAttachment() as (ConnRecord & { _connId?: string }) | null;
  return rec?._connId ?? '';
}

function generateConnId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)),
    b => b.toString(16).padStart(2, '0')).join('');
}
