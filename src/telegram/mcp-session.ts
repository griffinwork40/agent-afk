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
import { emitSessionPhase } from '../agent/trace/emit.js';
import type { TraceWriter } from '../agent/trace/index.js';

export interface LoadTelegramMcpManagerOptions {
  /**
   * Witness-layer trace writer for the current session. When present,
   * `loadTelegramMcpManager` emits `mcp_connect_start`/`mcp_connect_done`
   * span events around the connect phase (surface-parity with chat.ts) and
   * threads the writer into `McpManager.fromConfig` so per-server
   * `mcp_server_start`/`mcp_server_done` events are also captured.
   */
  traceWriter?: TraceWriter;
}

export async function loadTelegramMcpManager(
  cwd: string | undefined,
  opts: LoadTelegramMcpManagerOptions = {},
): Promise<McpManager | undefined> {
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

  const mcpStartedAt = Date.now();
  void emitSessionPhase(opts.traceWriter, {
    phase: 'mcp_connect_start',
    metadata: { serverCount: enabledCount },
  });
  try {
    return await McpManager.fromConfig(loaded.mcpServers, {
      warnings: loaded.warnings,
      ...(opts.traceWriter !== undefined ? { traceWriter: opts.traceWriter } : {}),
    });
  } finally {
    void emitSessionPhase(opts.traceWriter, {
      phase: 'mcp_connect_done',
      durationMs: Date.now() - mcpStartedAt,
      metadata: { serverCount: enabledCount },
    });
  }
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
