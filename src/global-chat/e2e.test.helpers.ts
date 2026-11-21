/**
 * In-memory socket pair for e2e tests.
 *
 * ClientEnd implements ChatSocket (what GlobalChatClient injects).
 * InMemoryRelay drives Room.onConnect / onMessage / onClose and
 * applies returned effects synchronously within each flush() call.
 *
 * Keep <=350 lines.
 */
import { Room, MemoryRelayStore } from './relay/index.js';
import type { ConnRecord, RelayConfig, RoomEffect } from './relay/index.js';
import type { RelayFrame } from './protocol.js';
import type { ChatSocket, ChatSocketConstructor } from './client.transport.js';

// ---------------------------------------------------------------------------
// ClientEnd
// ---------------------------------------------------------------------------

type MsgListener = (event: { data: unknown }) => void;
type VoidListener = () => void;

export class ClientEnd implements ChatSocket {
  sent: string[] = [];
  closed = false;
  connId: string | undefined;
  private _openListeners: VoidListener[] = [];
  private _closeListeners: VoidListener[] = [];
  private _errorListeners: VoidListener[] = [];
  private _msgListeners: MsgListener[] = [];

  receive(frame: RelayFrame): void {
    const data = JSON.stringify(frame);
    for (const fn of this._msgListeners) fn({ data });
  }

  triggerOpen(): void { for (const fn of this._openListeners) fn(); }
  triggerClose(): void { for (const fn of this._closeListeners) fn(); }
  triggerError(): void { for (const fn of this._errorListeners) fn(); }

  send(data: string): void {
    if (this.closed) throw new Error('ClientEnd: send on closed socket');
    this.sent.push(data);
  }
  close(): void { this.closed = true; }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: MsgListener): void;
  addEventListener(type: unknown, listener: unknown): void {
    if (type === 'open') this._openListeners.push(listener as VoidListener);
    else if (type === 'close') this._closeListeners.push(listener as VoidListener);
    else if (type === 'error') this._errorListeners.push(listener as VoidListener);
    else if (type === 'message') this._msgListeners.push(listener as MsgListener);
  }
}

// ---------------------------------------------------------------------------
// InMemoryRelay
// ---------------------------------------------------------------------------

export class InMemoryRelay {
  readonly store = new MemoryRelayStore();
  readonly room: Room;
  readonly conns = new Map<string, { end: ClientEnd; record: ConnRecord }>();
  private nextId = 1;
  _time = Date.now();

  constructor(config?: Partial<RelayConfig>) {
    const cfg: RelayConfig = {
      maintainerKeys: [],
      maxConnsPerIp: 10,
      ...config,
    };
    this.room = new Room(this.store, cfg, { now: () => this._time });
  }

  setTime(ms: number): void { this._time = ms; }
  advanceTime(ms: number): void { this._time += ms; }

  /**
   * Register a new ClientEnd with the relay (calls Room.onConnect).
   * Returns the connId. The caller must triggerOpen() on the end after
   * setting up listeners, then call flush(connId) to process sent frames.
   */
  register(end: ClientEnd, ipHash = 'ip1'): string {
    const connId = `conn${this.nextId++}`;
    const record = this.room.onConnect(connId, ipHash);
    end.connId = connId;
    this.conns.set(connId, { end, record });
    return connId;
  }

  /** Build a ChatSocketConstructor that always returns the given ClientEnd. */
  socketFactory(end: ClientEnd): ChatSocketConstructor {
    return class implements ChatSocket {
      constructor(_url: string) {}
      send(data: string): void { end.send(data); }
      close(): void { end.close(); }
      addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
      addEventListener(type: 'message', listener: MsgListener): void;
      addEventListener(type: unknown, listener: unknown): void {
        end.addEventListener(type as 'open', listener as VoidListener);
      }
    };
  }

  /**
   * Drain all pending messages from the given ClientEnd (by connId),
   * apply each RoomEffect to deliver frames back to sockets.
   */
  async flush(connId: string): Promise<void> {
    const entry = this.conns.get(connId);
    if (!entry) return;
    while (entry.end.sent.length) {
      const raw = entry.end.sent.shift()!;
      const effect = await this.room.onMessage(connId, raw, entry.record, this._allConns());
      entry.record = effect.conn;
      await this._applyEffect(connId, effect);
    }
  }

  /** Close a connection and apply the disconnect effect. */
  async disconnect(connId: string): Promise<void> {
    const entry = this.conns.get(connId);
    if (!entry) return;
    const effect = await this.room.onClose(connId, entry.record, this._allConns());
    this.conns.delete(connId);
    await this._applyEffect(connId, effect);
    entry.end.triggerClose();
  }

  private _allConns(): ReadonlyMap<string, ConnRecord> {
    const m = new Map<string, ConnRecord>();
    for (const [id, { record }] of this.conns) m.set(id, record);
    return m;
  }

  async _applyEffect(senderConnId: string, effect: RoomEffect): Promise<void> {
    // Update sender record first
    const senderEntry = this.conns.get(senderConnId);
    if (senderEntry) senderEntry.record = effect.conn;

    // Send to sender
    for (const frame of effect.toSender) {
      senderEntry?.end.receive(frame);
    }
    // Broadcast to all hello'd connections
    for (const frame of effect.toBroadcast) {
      for (const [cid, { end, record }] of this.conns) {
        if (record.helloOk || cid === senderConnId) {
          end.receive(frame);
        }
      }
    }
    // Force-close connections: mark the socket closed and remove from relay.
    // Do NOT call triggerClose() here -- the error frame was already delivered
    // via toSender/toBroadcast above, and triggerClose() would fire before the
    // #incoming microtask processes the error, making current()=false and
    // silently dropping the error frame. The client closes itself via
    // terminal() after processing the error.
    for (const closeId of effect.toClose) {
      const entry = this.conns.get(closeId);
      if (entry) {
        this.conns.delete(closeId);
        entry.end.close();
      }
    }
  }
}
