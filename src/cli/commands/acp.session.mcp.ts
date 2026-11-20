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
    // Client-supplied MCP servers are started at session creation time, before
    // any tool approval, and are trusted at the 'cli' (operator) level, the same
    // as servers named on the AFK command line with --mcp-server. The ACP model
    // is that the local GUI client is operator-controlled: its executable paths
    // run with the user's privileges without a prompt, matching D12 in the
    // profile. Tools from these servers are still always asked (section 6).
    // Do not inherit a displaced project server's trust metadata.
    loaded.serverLayers[name] = 'cli';
    delete loaded.userAllowSecretEnv[name];
  }
  return connectMcpTraced(loaded, traceWriter);
}
