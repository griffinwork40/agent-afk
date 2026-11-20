import { ChatRoom } from './room-object.js';

export { ChatRoom };

interface Env {
  ROOM: DurableObjectNamespace;
  ADMIN_PUBKEYS: string;
  IP_SALT: string;
  ROOM_NOTICE?: string;
  ROOM_MODE?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return new Response('afk-global-chat-relay ok', { status: 200 });
    }

    // WebSocket upgrade for the single global room
    if (url.pathname === '/v1/room/global') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      // Route to the single named Durable Object instance
      const id = env.ROOM.idFromName('global');
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
