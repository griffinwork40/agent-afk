/**
 * Lightweight Jev connection helper.
 *
 * Loads only the 'jev' server from the user's MCP config, connects it via
 * `McpManager.fromConfig()`, and returns a `callTool` function that invokes
 * the `mcp__jev__jev_ask` handler.
 *
 * Returns `undefined` when:
 *  - no 'jev' server is configured in `~/.afk/config/mcp.json`
 *  - the server fails to connect
 *
 * `close()` shuts down the McpManager and disconnects the server.
 *
 * @module whatif/judge/jev-connect
 */

import { loadMcpConfig } from '../../agent/mcp/config-loader.js';
import { McpManager } from '../../agent/mcp/manager.js';
import { errorMessage } from '../../utils/errors.js';

export interface JevConnection {
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

const JEV_SERVER_NAME = 'jev';
const JEV_WIRE_PREFIX = 'mcp__jev__';

/**
 * Connect ONLY the 'jev' MCP server from the loaded config.
 * Returns `undefined` when not configured or when connection fails.
 */
export async function connectJev(): Promise<JevConnection | undefined> {
  let loaded;
  try {
    loaded = loadMcpConfig({ skipProjectLocal: true });
  } catch {
    return undefined;
  }

  const { mcpServers, serverLayers, userAllowSecretEnv } = loaded;

  // Filter to only the 'jev' server.
  if (!Object.prototype.hasOwnProperty.call(mcpServers, JEV_SERVER_NAME)) {
    return undefined;
  }

  const jevOnly: Record<string, (typeof mcpServers)[string]> = {
    [JEV_SERVER_NAME]: mcpServers[JEV_SERVER_NAME]!,
  };
  const jevLayers = { [JEV_SERVER_NAME]: serverLayers[JEV_SERVER_NAME] ?? 'user-global' };
  const jevAllow = { [JEV_SERVER_NAME]: userAllowSecretEnv[JEV_SERVER_NAME] ?? [] };

  let manager: McpManager;
  try {
    manager = await McpManager.fromConfig(jevOnly, {
      serverLayers: jevLayers,
      userAllowSecretEnv: jevAllow,
    });
  } catch (err) {
    console.warn(`[jev-connect] failed to connect Jev MCP server: ${errorMessage(err)}`);
    return undefined;
  }

  // Verify the handler is actually available.
  const handlers = manager.getMcpHandlers();
  const hasJevAsk = [...handlers.keys()].some((k) => k.startsWith(JEV_WIRE_PREFIX));
  if (!hasJevAsk) {
    await manager.disconnectAll().catch(() => undefined);
    return undefined;
  }

  return {
    async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
      const freshHandlers = manager.getMcpHandlers();
      const handler = freshHandlers.get(name);
      if (!handler) {
        throw new Error(`[jev-connect] no handler for tool "${name}"`);
      }
      // ToolHandler signature: (input, signal, context?) => Promise<ToolResult>
      const abortCtl = new AbortController();
      if (signal?.aborted) abortCtl.abort();
      signal?.addEventListener('abort', () => abortCtl.abort());
      return handler(args, abortCtl.signal);
    },

    async close(): Promise<void> {
      await manager.disconnectAll().catch(() => undefined);
    },
  };
}
