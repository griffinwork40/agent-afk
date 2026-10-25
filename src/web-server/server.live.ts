/**
 * Live-text + warm-MCP wiring for `startWebServer` (extracted: server.ts sits at
 * the 350-code-line ceiling).
 *
 * @module web-server/server.live
 */
import { LiveBroker } from './live-broker.js';
import type { RouteContext } from './routes.js';
import type { SessionOwner } from './session-owner.js';

/** Route context plus server-scoped brokers that only server.ts wires. */
export type ServerContext = RouteContext & { liveBroker?: LiveBroker };

/**
 * Create the server-scoped live broker, tap it into the owner's turns, and
 * start the owner's warm MCP spare. `stop` reverses both (teardown first).
 */
export function wireLive(owner: SessionOwner | undefined): { liveBroker: LiveBroker; stop: () => Promise<void> } {
  const liveBroker = new LiveBroker();
  owner?.setLiveSink?.(liveBroker);
  const disposeWarmMcp = owner?.prewarm?.();
  return {
    liveBroker,
    stop: async () => {
      liveBroker.cancelAll();
      owner?.setLiveSink?.(undefined);
      await disposeWarmMcp?.().catch(() => {});
    },
  };
}
