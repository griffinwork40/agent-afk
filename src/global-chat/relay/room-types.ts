import type { RelayFrame, RoomMode } from '../protocol.js';

// Contract:
// ConnRecord is the per-connection serializable state persisted by the
// Durable Object adapter (via serializeAttachment/deserializeAttachment).
// It must survive hibernation. Keep it small and JSON-round-trippable.
// Fields are null until hello completes.

export interface ConnRecord {
  /** Null until hello succeeds. */
  pubkey: string | null;
  name: string | null;
  ipHash: string;
  /** True once hello has been accepted. */
  helloOk: boolean;
}

export interface RelayConfig {
  /** Hex public keys of maintainers (may change at restart). */
  maintainerKeys: readonly string[];
  /** Optional notice shown in welcome. */
  notice?: string;
  /** Operator override for room mode (kill switch); wins over stored mode. */
  forcedMode?: RoomMode;
  /** Maximum concurrent connections per ip hash. */
  maxConnsPerIp: number;
}

// Effect returned by room event handlers.
// The adapter reads these and drives the actual WebSocket API.
export interface RoomEffect {
  /** Frames to send to the connection that triggered the event. */
  toSender: RelayFrame[];
  /** Frames to broadcast to ALL hello'd connections (including sender if hello'd). */
  toBroadcast: RelayFrame[];
  /** Connection ids to forcibly close (after sending their toSender frames). */
  toClose: string[];
  /** Private frames, delivered only to their named connection before closing. */
  toConnections?: { connId: string; frame: RelayFrame }[];
  /** Updated per-connection record (replace the stored attachment). */
  conn: ConnRecord;
}
