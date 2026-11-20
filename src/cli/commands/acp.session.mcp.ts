import { loadMcpConfig } from '../../agent/mcp/index.js';
import type { McpManager } from '../../agent/mcp/index.js';
import { connectMcpTraced } from '../../agent/mcp/connect-traced.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../config/import-sources.js';
import type { TraceWriter } from '../../agent/trace/writer.js';
import type { AcpSessionOptions } from './acp.session.js';
import { connectMcpForChat } from './chat.mcp-setup.js';

/** Connect once, before constructing the provider that owns the tool schemas. */
export async function connectAcpMcp(
  cwd: string,
  servers: AcpSessionOptions['mcpServers'],
  traceWriter: TraceWriter | undefined,
): Promise<McpManager | undefined> {
  if (servers === undefined || Object.keys(servers).length === 0) {
    return connectMcpForChat({ worktreeCwd: cwd, mcpConfigOverride: undefined, traceWriter });
  }
  // chat's helper accepts only an on-disk override, not a programmatic layer.
  // Reuse its loader/connector rather than writing a temporary config file.
  const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
    .mcpConfigs.filter((c) => c.format === 'json').map((c) => c.source);
  const loaded = loadMcpConfig({ cwd, ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}) });
  for (const [name, config] of Object.entries(servers)) {
    loaded.mcpServers[name] = config;
    // ACP's local stdio peer is an operator-controlled GUI, equivalent to a CLI
    // override. These commands execute at connect time, before tool approval.
    // Do not accidentally inherit a displaced project server's trust metadata.
    loaded.serverLayers[name] = 'cli';
    delete loaded.userAllowSecretEnv[name];
  }
  return connectMcpTraced(loaded, traceWriter);
}
