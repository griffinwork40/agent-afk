import type { Msg, RoomMode } from '../protocol.js';

// Contract:
// RelayStore is the persistence boundary for the relay. Every field that must
// survive Durable Object hibernation goes through this interface. In-memory
// rate-limit counters (TokenBucket, sliding windows) may live outside it;
// losing them after an idle period is acceptable per the brief -- the effect
// is that a client gets a brief quota reset after the DO hibernates.

export interface KeyRecord {
  pubkey: string;
  name: string;
  firstSeenAt: number;
  nameChangedAt: number;
}

export interface RelayStore {
  // --- messages ---
  insertMessage(msg: Msg): Promise<void>;
  markDeleted(id: string): Promise<void>;
  /** Returns newest N non-deleted messages in chronological order (oldest first). */
  getBacklog(n: number): Promise<Msg[]>;
  getMessageById(id: string): Promise<Msg | null>;
  pruneOlderThan(cutoffMs: number): Promise<void>;
  countPostsByKeySince(pubkey: string, sinceMs: number): Promise<number>;

  // --- bans ---
  addBan(pubkey: string, ipHash: string): Promise<void>;
  removeBan(pubkey: string): Promise<void>;
  isBannedKey(pubkey: string): Promise<boolean>;
  isBannedIp(ipHash: string): Promise<boolean>;

  // --- key registry ---
  getKeyRecord(pubkey: string): Promise<KeyRecord | null>;
  upsertKeyRecord(record: KeyRecord): Promise<void>;

  // --- reports ---
  addReport(messageId: string, reporterKey: string): Promise<void>;
  countReporters(messageId: string): Promise<number>;

  // --- room mode ---
  getRoomMode(): Promise<RoomMode>;
  setRoomMode(mode: RoomMode): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemoryRelayStore -- used by unit tests (and optionally miniflare local dev)
// ---------------------------------------------------------------------------

interface StoredMsg extends Msg { deleted: boolean }

export class MemoryRelayStore implements RelayStore {
  private readonly messages = new Map<string, StoredMsg>();
  private readonly messageOrder: string[] = [];
  private readonly bannedKeys = new Map<string, string>(); // pubkey -> ipHash
  private readonly keys = new Map<string, KeyRecord>();
  // messageId -> Set<reporterKey>
  private readonly reports = new Map<string, Set<string>>();
  private mode: RoomMode = 'open';

  async insertMessage(msg: Msg): Promise<void> {
    if (this.messages.has(msg.id)) return;
    this.messages.set(msg.id, { ...msg, deleted: false });
    this.messageOrder.push(msg.id);
  }

  async markDeleted(id: string): Promise<void> {
    const m = this.messages.get(id);
    if (m) m.deleted = true;
  }

  async getBacklog(n: number): Promise<Msg[]> {
    const result: Msg[] = [];
    for (let i = this.messageOrder.length - 1; i >= 0 && result.length < n; i--) {
      const id = this.messageOrder[i];
      if (!id) continue;
      const m = this.messages.get(id);
      if (m && !m.deleted) result.unshift(m);
    }
    return result;
  }

  async getMessageById(id: string): Promise<Msg | null> {
    const m = this.messages.get(id);
    return m ?? null;
  }

  async pruneOlderThan(cutoffMs: number): Promise<void> {
    const toDelete: string[] = [];
    for (const [id, m] of this.messages) {
      if (m.ts < cutoffMs) toDelete.push(id);
    }
    for (const id of toDelete) {
      this.messages.delete(id);
      this.reports.delete(id);
    }
    const deleted = new Set(toDelete);
    this.messageOrder.splice(0, this.messageOrder.length,
      ...this.messageOrder.filter(id => !deleted.has(id)));
  }

  async countPostsByKeySince(pubkey: string, sinceMs: number): Promise<number> {
    let count = 0;
    for (const m of this.messages.values()) {
      if (m.pubkey === pubkey && m.ts >= sinceMs && !m.deleted) count++;
    }
    return count;
  }

  async addBan(pubkey: string, ipHash: string): Promise<void> {
    this.bannedKeys.set(pubkey, ipHash);
  }

  async removeBan(pubkey: string): Promise<void> {
    this.bannedKeys.delete(pubkey);
  }

  async isBannedKey(pubkey: string): Promise<boolean> {
    return this.bannedKeys.has(pubkey);
  }

  async isBannedIp(ipHash: string): Promise<boolean> {
    return ipHash !== '' && [...this.bannedKeys.values()].includes(ipHash);
  }

  async getKeyRecord(pubkey: string): Promise<KeyRecord | null> {
    return this.keys.get(pubkey) ?? null;
  }

  async upsertKeyRecord(record: KeyRecord): Promise<void> {
    const firstSeenAt = this.keys.get(record.pubkey)?.firstSeenAt ?? record.firstSeenAt;
    this.keys.set(record.pubkey, { ...record, firstSeenAt });
  }

  async addReport(messageId: string, reporterKey: string): Promise<void> {
    let set = this.reports.get(messageId);
    if (!set) { set = new Set(); this.reports.set(messageId, set); }
    set.add(reporterKey);
  }

  async countReporters(messageId: string): Promise<number> {
    return this.reports.get(messageId)?.size ?? 0;
  }

  async getRoomMode(): Promise<RoomMode> { return this.mode; }
  async setRoomMode(mode: RoomMode): Promise<void> { this.mode = mode; }
}
