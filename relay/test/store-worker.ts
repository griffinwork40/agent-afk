// Test-only entry point. Never referenced by wrangler.toml or production worker.
import { SqliteRelayStore } from '../src/sqlite-store.js';

export class StoreTestObject {
  private readonly store: SqliteRelayStore;
  constructor(ctx: DurableObjectState) {
    this.store = new SqliteRelayStore(ctx.storage.sql);
    this.store.ensureSchema();
  }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { method: string; args: unknown[] };
    const methods: Record<string, (...args: any[]) => unknown> = {
      insertMessage: (...a) => this.store.insertMessage(a[0]),
      markDeleted: (...a) => this.store.markDeleted(a[0]),
      getBacklog: (...a) => this.store.getBacklog(a[0]),
      getMessageById: (...a) => this.store.getMessageById(a[0]),
      pruneOlderThan: (...a) => this.store.pruneOlderThan(a[0]),
      countPostsByKeySince: (...a) => this.store.countPostsByKeySince(a[0], a[1]),
      addBan: (...a) => this.store.addBan(a[0], a[1]),
      removeBan: (...a) => this.store.removeBan(a[0]),
      isBannedKey: (...a) => this.store.isBannedKey(a[0]),
      isBannedIp: (...a) => this.store.isBannedIp(a[0]),
      getKeyRecord: (...a) => this.store.getKeyRecord(a[0]),
      upsertKeyRecord: (...a) => this.store.upsertKeyRecord(a[0]),
      pruneKeyRecords: (...a) => this.store.pruneKeyRecords(a[0]),
      getOldestKeyTimestamp: () => this.store.getOldestKeyTimestamp(),
      consumeActionId: (...a) => this.store.consumeActionId(a[0], a[1], a[2]),
      pruneActionIds: (...a) => this.store.pruneActionIds(a[0]),
      getOldestActionExpiry: () => this.store.getOldestActionExpiry(),
      addReport: (...a) => this.store.addReport(a[0], a[1]),
      countReporters: (...a) => this.store.countReporters(a[0]),
      getRoomMode: () => this.store.getRoomMode(),
      setRoomMode: (...a) => this.store.setRoomMode(a[0]),
    };
    const method = methods[input.method];
    if (!method) return new Response('Unknown test operation', { status: 400 });
    return Response.json({ result: await method(...input.args) ?? null });
  }
}
export default {
  fetch(request: Request, env: { TEST: DurableObjectNamespace }): Promise<Response> {
    return env.TEST.get(env.TEST.idFromName('test')).fetch(request);
  },
};
