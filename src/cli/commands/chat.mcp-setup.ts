/**
 * MCP connection setup for `afk chat`.
 *
 * Extracted from chat.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `connectMcpForChat`, `ChatMcpSetupParams`.
 */

import { McpManager, loadMcpConfig } from '../../agent/mcp/index.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../config/import-sources.js';
import { emitSessionPhase } from '../../agent/trace/emit.js';
import type { TraceWriter } from '../../agent/trace/writer.js';

// ---------------------------------------------------------------------------
// Parameter shape
// ---------------------------------------------------------------------------

export interface ChatMcpSetupParams {
  worktreeCwd: string | undefined;
  mcpConfigOverride: string | undefined;
  traceWriter: TraceWriter | undefined;
}

// ---------------------------------------------------------------------------
// MCP connection helper
// ---------------------------------------------------------------------------

/**
 * Load the MCP config and connect to all enabled servers.
 * Returns `undefined` when no enabled servers are configured.
 * Warnings from a zero-server config are written to stderr.
 */
export async function connectMcpForChat(
  params: ChatMcpSetupParams,
): Promise<McpManager | undefined> {
  const { worktreeCwd, mcpConfigOverride, traceWriter } = params;
  const projectCwd = worktreeCwd ?? process.cwd();
  const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
    .mcpConfigs.filter((c) => c.format === 'json')
    .map((c) => c.source);
  const loaded = loadMcpConfig({
    cwd: projectCwd,
    ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}),
    ...(mcpConfigOverride !== undefined ? { cliOverride: mcpConfigOverride } : {}),
  });
  const enabledCount = Object.values(loaded.mcpServers).filter((s) => !s.disabled).length;

  if (enabledCount === 0) {
    // Surface any config warnings even when no servers are active.
    for (const w of loaded.warnings) {
      process.stderr.write(`[mcp] ${w}\n`);
    }
    return undefined;
  }

  const mcpStartedAt = Date.now();
  void emitSessionPhase(traceWriter, {
    phase: 'mcp_connect_start',
    metadata: { serverCount: enabledCount },
  });

  let mcpManager: McpManager | undefined;
  try {
    mcpManager = await McpManager.fromConfig(loaded.mcpServers, {
      warnings: loaded.warnings,
      serverLayers: loaded.serverLayers,
      userAllowSecretEnv: loaded.userAllowSecretEnv,
      ...(traceWriter !== undefined ? { traceWriter } : {}),
    });
  } finally {
    void emitSessionPhase(traceWriter, {
      phase: 'mcp_connect_done',
      durationMs: Date.now() - mcpStartedAt,
      metadata: { serverCount: enabledCount },
    });
  }

  return mcpManager;
}
