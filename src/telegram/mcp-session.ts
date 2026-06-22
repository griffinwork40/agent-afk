/**
 * Telegram MCP session wiring.
 *
 * Telegram constructs one AgentSession per chat, so MCP managers must be
 * session-scoped too: load configured servers before provider construction,
 * pass the manager into the provider, then disconnect it after the session
 * closes. No configured/enabled servers returns `undefined` so the historical
 * no-MCP path is unchanged.
 */

import type { IAgentSession } from '../agent/types.js';
import { McpManager, loadMcpConfig, getMcpConfigPath } from '../agent/mcp/index.js';
import { loadImportFromConfig, resolveImportedRoots } from '../config/import-sources.js';

export async function loadTelegramMcpManager(cwd: string | undefined): Promise<McpManager | undefined> {
  const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
    .mcpConfigs.filter((c) => c.format === 'json')
    .map((c) => c.source);
  const loaded = loadMcpConfig({
    cwd: cwd ?? process.cwd(),
    ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}),
  });
  const enabledCount = Object.values(loaded.mcpServers).filter((s) => !s.disabled).length;
  if (enabledCount === 0) {
    for (const w of loaded.warnings) console.warn(`[mcp] ${w}`);
    return undefined;
  }

  const sourcesLabel = loaded.sources.length === 1
    ? loaded.sources[0]
    : `${loaded.sources.length} source(s)`;
  console.log(`  mcp: ${enabledCount} server(s) from ${sourcesLabel ?? getMcpConfigPath()}`);
  return McpManager.fromConfig(loaded.mcpServers, { warnings: loaded.warnings });
}

export function attachMcpCleanup<T extends IAgentSession>(session: T, mcpManager: McpManager | undefined): T {
  if (mcpManager === undefined) return session;

  const closeSession = session.close.bind(session);
  let disconnected = false;
  session.close = (async () => {
    try {
      await closeSession();
    } finally {
      if (!disconnected) {
        disconnected = true;
        await mcpManager.disconnectAll();
      }
    }
  }) as T['close'];

  return session;
}
