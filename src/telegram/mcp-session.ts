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
  /**
   * Optional callback for surfacing per-server connection failures to the
   * operator. When provided, called once per failed server after
   * `McpManager.fromConfig` completes. Falls back to `console.warn` when
   * omitted. Callers on the Telegram surface pass a closure that sends the
   * warning to the originating chat (mirroring how the REPL routes failures
   * through `recordBootWarning`).
   */
  sendWarning?: (msg: string) => void;
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
  let manager: McpManager;
  try {
    manager = await McpManager.fromConfig(loaded.mcpServers, {
      warnings: loaded.warnings,
      serverLayers: loaded.serverLayers,
      userAllowSecretEnv: loaded.userAllowSecretEnv,
      ...(opts.traceWriter !== undefined ? { traceWriter: opts.traceWriter } : {}),
    });
  } finally {
    void emitSessionPhase(opts.traceWriter, {
      phase: 'mcp_connect_done',
      durationMs: Date.now() - mcpStartedAt,
      metadata: { serverCount: enabledCount },
    });
  }

  // Surface non-alwaysLoad server connection failures as operator-visible
  // warnings (mirrors the REPL's `connectReplMcp` pattern). Callers that
  // supply `sendWarning` route these to the Telegram chat; others fall back
  // to stderr so failures are never silently discarded.
  const warn = opts.sendWarning ?? ((msg: string) => console.warn(msg));
  for (const s of manager.getServerStates()) {
    if (s.status === 'error') {
      warn(`[mcp] server "${s.serverName}" failed to connect: ${s.error ?? 'unknown error'}`);
    }
  }

  return manager;
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
