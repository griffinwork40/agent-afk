import type { RelayStore, KeyRecord } from '../../src/global-chat/relay/store.js';
import type { Msg, RoomMode } from '../../src/global-chat/protocol.js';

// Contract:
// SqliteRelayStore wraps ctx.storage.sql (Durable Object SQLite).
// Schema is created on first access via ensureSchema().
// Messages are pruned to RETENTION_MS (7 days); backlog is newest 50 not deleted.
// Bans are stored as (pubkey, ipHash) pairs; ipHash may be empty string for
// key-only bans or bans where no live connection was present at ban time.
// Reports are stored as (messageId, reporterKey) unique pairs.
// Room mode defaults to 'open' when no row exists.

type SqlStorage = DurableObjectState['storage']['sql'];

export class SqliteRelayStore implements RelayStore {
  constructor(private readonly sql: SqlStorage) {}

  ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        pubkey TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        sig TEXT NOT NULL,
        badge TEXT,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);

      CREATE TABLE IF NOT EXISTS bans (
        pubkey TEXT PRIMARY KEY,
        ip_hash TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS bans_ip ON bans(ip_hash) WHERE ip_hash != '';

      CREATE TABLE IF NOT EXISTS key_registry (
        pubkey TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        name_changed_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS key_registry_last_seen ON key_registry(last_seen_at);
      CREATE INDEX IF NOT EXISTS messages_pubkey ON messages(pubkey);

      CREATE TABLE IF NOT EXISTS reports (
        message_id TEXT NOT NULL,
        reporter_key TEXT NOT NULL,
        PRIMARY KEY (message_id, reporter_key)
      );

      CREATE TABLE IF NOT EXISTS action_ids (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS action_ids_expiry ON action_ids(expires_at);

      CREATE TABLE IF NOT EXISTS room_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async insertMessage(msg: Msg): Promise<void> {
    this.sql.exec(
      `INSERT OR IGNORE INTO messages (id, ts, pubkey, name, text, sig, badge, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      msg.id, msg.ts, msg.pubkey, msg.name, msg.text, msg.sig, msg.badge ?? null,
    );
  }

  async markDeleted(id: string): Promise<void> {
    this.sql.exec(`UPDATE messages SET deleted = 1 WHERE id = ?`, id);
  }

  async getBacklog(n: number): Promise<Msg[]> {
    const rows = this.sql.exec<{
      id: string; ts: number; pubkey: string; name: string;
      text: string; sig: string; badge: string | null;
    }>(
      `SELECT id, ts, pubkey, name, text, sig, badge
       FROM messages WHERE deleted = 0
         AND ts >= COALESCE((SELECT CAST(value AS INTEGER) FROM room_state WHERE key = 'prune_cutoff'), 0)
       ORDER BY ts DESC, rowid DESC LIMIT ?`,
      n,
    ).toArray();
    // Reverse so result is chronological (oldest first)
    return rows.reverse().map(r => ({
      id: r.id, ts: r.ts, pubkey: r.pubkey, name: r.name,
      text: r.text, sig: r.sig,
      ...(r.badge ? { badge: r.badge as 'maintainer' } : {}),
    }));
  }

  async getMessageById(id: string): Promise<Msg | null> {
    const rows = this.sql.exec<{
      id: string; ts: number; pubkey: string; name: string;
      text: string; sig: string; badge: string | null; deleted: number;
    }>(
      `SELECT id, ts, pubkey, name, text, sig, badge, deleted FROM messages WHERE id = ?`,
      id,
    ).toArray();
    const r = rows[0];
    if (!r) return null;
    // Return even if deleted; callers check the deleted field via store.getMessageById
    // and the MemoryStore returns StoredMsg with deleted field. For the SQLite store we
    // need to signal deletion. We encode it via a sentinel so callers that cast to
    // StoredMsg see it. The relay only calls getMessageById for duplicate-check and
    // report-target-check; for the latter it checks (target as any).deleted.
    return {
      id: r.id, ts: r.ts, pubkey: r.pubkey, name: r.name, text: r.text, sig: r.sig,
      ...(r.badge ? { badge: r.badge as 'maintainer' } : {}),
      // Attach deleted flag as a non-Msg extra property for relay checks
      ...({ deleted: r.deleted === 1 } as unknown as object),
    } as Msg;
  }

  async pruneOlderThan(cutoffMs: number): Promise<void> {
    // Hide all expired rows immediately, but bound physical cleanup per event.
    // Synchronous SQL calls are committed together by the DO storage runtime.
    this.sql.exec(`INSERT INTO room_state (key, value) VALUES ('prune_cutoff', ?)
      ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`, cutoffMs);
    this.sql.exec(`DELETE FROM reports WHERE message_id IN
      (SELECT id FROM messages WHERE ts < ? ORDER BY rowid LIMIT 100)`, cutoffMs);
    this.sql.exec(`DELETE FROM messages WHERE rowid IN
      (SELECT rowid FROM messages WHERE ts < ? ORDER BY rowid LIMIT 100)`, cutoffMs);
  }

  async getOldestMessageTimestamp(): Promise<number | null> {
    const row = this.sql.exec<{ ts: number }>(`SELECT ts FROM messages ORDER BY ts LIMIT 1`).toArray()[0];
    return row?.ts ?? null;
  }

  async countPostsByKeySince(pubkey: string, sinceMs: number): Promise<number> {
    const rows = this.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM messages WHERE pubkey = ? AND ts >= ? AND deleted = 0`,
      pubkey, sinceMs,
    ).toArray();
    return rows[0]?.cnt ?? 0;
  }

  async addBan(pubkey: string, ipHash: string): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO bans (pubkey, ip_hash) VALUES (?, ?)`,
      pubkey, ipHash,
    );
  }

  async removeBan(pubkey: string): Promise<void> {
    this.sql.exec(`DELETE FROM bans WHERE pubkey = ?`, pubkey);
  }

  async isBannedKey(pubkey: string): Promise<boolean> {
    const rows = this.sql.exec<{ pubkey: string }>(
      `SELECT pubkey FROM bans WHERE pubkey = ? LIMIT 1`, pubkey,
    ).toArray();
    return rows.length > 0;
  }

  async isBannedIp(ipHash: string): Promise<boolean> {
    if (!ipHash) return false;
    const rows = this.sql.exec<{ pubkey: string }>(
      `SELECT pubkey FROM bans WHERE ip_hash = ? LIMIT 1`, ipHash,
    ).toArray();
    return rows.length > 0;
  }

  async getKeyRecord(pubkey: string): Promise<KeyRecord | null> {
    const rows = this.sql.exec<{
      pubkey: string; name: string; first_seen_at: number; name_changed_at: number; last_seen_at: number;
    }>(
      `SELECT pubkey, name, first_seen_at, name_changed_at, last_seen_at FROM key_registry WHERE pubkey = ?`,
      pubkey,
    ).toArray();
    const r = rows[0];
    if (!r) return null;
    return { pubkey: r.pubkey, name: r.name, firstSeenAt: r.first_seen_at,
      nameChangedAt: r.name_changed_at, lastSeenAt: r.last_seen_at };
  }

  async upsertKeyRecord(record: KeyRecord): Promise<void> {
    this.sql.exec(
      `INSERT INTO key_registry (pubkey, name, first_seen_at, name_changed_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET
         name = excluded.name,
         name_changed_at = excluded.name_changed_at,
         last_seen_at = excluded.last_seen_at`,
      record.pubkey, record.name, record.firstSeenAt, record.nameChangedAt, record.lastSeenAt,
    );
  }

  async pruneKeyRecords(cutoffMs: number): Promise<void> {
    this.sql.exec(`DELETE FROM key_registry WHERE pubkey IN (
      SELECT k.pubkey FROM key_registry k WHERE k.last_seen_at < ?
      AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.pubkey = k.pubkey)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.pubkey = k.pubkey)
      ORDER BY k.last_seen_at LIMIT 100)`, cutoffMs);
  }

  async getOldestKeyTimestamp(): Promise<number | null> {
    const row = this.sql.exec<{ ts: number }>(`SELECT k.last_seen_at AS ts FROM key_registry k
      WHERE NOT EXISTS (SELECT 1 FROM bans b WHERE b.pubkey = k.pubkey)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.pubkey = k.pubkey)
      ORDER BY k.last_seen_at LIMIT 1`).toArray()[0];
    return row?.ts ?? null;
  }

  async addReport(messageId: string, reporterKey: string): Promise<void> {
    this.sql.exec(
      `INSERT OR IGNORE INTO reports (message_id, reporter_key) VALUES (?, ?)`,
      messageId, reporterKey,
    );
  }

  async countReporters(messageId: string): Promise<number> {
    const rows = this.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM reports WHERE message_id = ?`,
      messageId,
    ).toArray();
    return rows[0]?.cnt ?? 0;
  }

  async consumeActionId(key: string, expiresAt: number, now: number): Promise<boolean> {
    const rows = this.sql.exec<{ key: string }>(`INSERT INTO action_ids (key, expires_at) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at WHERE action_ids.expires_at <= ?
      RETURNING key`, key, expiresAt, now).toArray();
    return rows.length > 0;
  }

  async pruneActionIds(now: number): Promise<void> {
    this.sql.exec(`DELETE FROM action_ids WHERE key IN
      (SELECT key FROM action_ids WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`, now);
  }

  async getOldestActionExpiry(): Promise<number | null> {
    return this.sql.exec<{ expires_at: number }>(`SELECT expires_at FROM action_ids ORDER BY expires_at LIMIT 1`)
      .toArray()[0]?.expires_at ?? null;
  }

  async getRoomMode(): Promise<RoomMode> {
    const rows = this.sql.exec<{ value: string }>(
      `SELECT value FROM room_state WHERE key = 'mode' LIMIT 1`,
    ).toArray();
    const v = rows[0]?.value;
    if (v === 'open' || v === 'readonly' || v === 'closed') return v;
    return 'open';
  }

  async setRoomMode(mode: RoomMode): Promise<void> {
    this.sql.exec(
      `INSERT INTO room_state (key, value) VALUES ('mode', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      mode,
    );
  }
}
