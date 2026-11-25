// Test-only entry point: not reachable from wrangler.toml or production Worker.
import { ChatRoom } from '../src/room-object.js';
export class RetentionTestRoom extends ChatRoom {
  constructor(private readonly testCtx: DurableObjectState, env: any) { super(testCtx, env); }
  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/rows') {
      const rows = this.testCtx.storage.sql.exec('SELECT COUNT(*) AS n FROM messages').toArray();
      return Promise.resolve(Response.json(rows));
    }
    return super.fetch(request);
  }
}
export default {
  fetch(request: Request, env: { ROOM: DurableObjectNamespace }): Promise<Response> {
    return env.ROOM.get(env.ROOM.idFromName('global')).fetch(request);
  },
};
